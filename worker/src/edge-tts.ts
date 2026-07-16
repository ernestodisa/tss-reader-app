import { buildSSML } from './ssml-builder';
import type { TTSEngine } from './types';

// Edge TTS WebSocket protocol (mirrors the python edge-tts library):
// - MIME-style text messages with \r\n headers, blank line, then body
// - Binary frames: 2-byte big-endian header length prefix, header, raw MP3 bytes
// - Auth via TrustedClientToken + Sec-MS-GEC (DRM clock-based SHA-256 hash)

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
// Must track a current Edge release — Microsoft 403s stale Sec-MS-GEC-Version values
// (kept in sync with the python edge-tts lib's constants.py)
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
// NOTE: Workers' fetch() rejects wss:// — the WebSocket upgrade is requested over https://
const EDGE_TTS_WS_URL =
  'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

// Windows epoch offset (seconds between 1601-01-01 and 1970-01-01)
const WIN_EPOCH_OFFSET = 11644473600;

interface EdgeWordBoundary {
  wordIndex: number;
  text: string;
  offsetMs: number;
  durationMs: number;
}

async function generateSecMsGec(): Promise<string> {
  // Ticks: seconds since Windows epoch, in 100-ns units, rounded DOWN
  // to the nearest 5 minutes. BigInt is required — the value (~1.3e17)
  // exceeds Number.MAX_SAFE_INTEGER and float math corrupts the hash input.
  let secs = BigInt(Math.floor(Date.now() / 1000)) + BigInt(WIN_EPOCH_OFFSET);
  secs -= secs % 300n;
  const ticks = secs * 10_000_000n;

  const strToHash = `${ticks.toString()}${TRUSTED_CLIENT_TOKEN}`;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(strToHash),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function uuidNoDashes(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function dateHeader(): string {
  return new Date().toString();
}

function parseTextMessage(data: string): { headers: Record<string, string>; body: string } {
  const sep = data.indexOf('\r\n\r\n');
  const headerBlock = sep >= 0 ? data.slice(0, sep) : data;
  const body = sep >= 0 ? data.slice(sep + 4) : '';
  const headers: Record<string, string> = {};
  for (const line of headerBlock.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { headers, body };
}

export const edgeTTS: TTSEngine = {
  async synthesize(text: string, voiceId: string, speed: number): Promise<{
    audio: ArrayBuffer;
    words: EdgeWordBoundary[];
    durationMs: number;
  }> {
    const ssml = buildSSML(text, voiceId, speed);

    const secMsGec = await generateSecMsGec();
    const wsUrl =
      `${EDGE_TTS_WS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
      `&Sec-MS-GEC=${secMsGec}` +
      `&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}` +
      `&ConnectionId=${uuidNoDashes()}`;

    // Cloudflare Workers: open a client WebSocket via fetch upgrade.
    // Edge TTS validates browser-like headers (same set the python edge-tts lib sends).
    const wsResp = await fetch(wsUrl, {
      headers: {
        Upgrade: 'websocket',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent':
          `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
          `Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
      },
    });
    const ws = wsResp.webSocket;
    if (!ws) {
      throw new Error(`Failed to establish WebSocket connection to Edge TTS (HTTP ${wsResp.status})`);
    }
    ws.accept();

    return new Promise((resolve, reject) => {
      const audioChunks: Uint8Array[] = [];
      const words: EdgeWordBoundary[] = [];
      let wordCounter = 0;
      let settled = false;

      const timeout = setTimeout(() => {
        fail(new Error('Edge TTS timeout'));
      }, 25000);

      function done(result: { audio: ArrayBuffer; words: EdgeWordBoundary[]; durationMs: number }) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { ws!.close(); } catch { /* noop */ }
        resolve(result);
      }

      function fail(err: Error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { ws!.close(); } catch { /* noop */ }
        reject(err);
      }

      ws.addEventListener('message', (event: MessageEvent) => {
        try {
          if (typeof event.data === 'string') {
            const { headers, body } = parseTextMessage(event.data);
            const path = headers['Path'];
            if (path === 'turn.start') {
              // ignore
            } else if (path === 'audio.metadata') {
              try {
                const meta = JSON.parse(body);
                for (const entry of meta.Metadata || []) {
                  if (entry.Type === 'WordBoundary') {
                    words.push({
                      wordIndex: wordCounter++,
                      text: entry.Data?.text?.Text ?? '',
                      offsetMs: Math.round((entry.Data?.Offset ?? 0) / 10000),
                      durationMs: Math.round((entry.Data?.Duration ?? 0) / 10000),
                    });
                  }
                }
              } catch {
                // malformed metadata — ignore
              }
            } else if (path === 'turn.end') {
              const totalBytes = audioChunks.reduce((sum, c) => sum + c.length, 0);
              const audio = new Uint8Array(totalBytes);
              let offset = 0;
              for (const chunk of audioChunks) {
                audio.set(chunk, offset);
                offset += chunk.length;
              }
              const durationMs = words.length > 0
                ? words[words.length - 1].offsetMs + words[words.length - 1].durationMs
                : 0;
              done({ audio: audio.buffer, words, durationMs });
            }
          } else {
            // Binary frame: first 2 bytes = header length (big-endian),
            // header contains Path:audio, MP3 bytes follow the header.
            const buf: ArrayBuffer = event.data as ArrayBuffer;
            if (buf.byteLength < 2) return;
            const view = new DataView(buf);
            const headerLen = view.getUint16(0, false);
            const audioStart = 2 + headerLen;
            if (buf.byteLength > audioStart) {
              audioChunks.push(new Uint8Array(buf, audioStart));
            }
          }
        } catch (err) {
          fail(err instanceof Error ? err : new Error('Edge TTS message handling error'));
        }
      });

      ws.addEventListener('error', () => {
        fail(new Error('Edge TTS WebSocket error'));
      });

      ws.addEventListener('close', () => {
        fail(new Error('Edge TTS WebSocket closed before turn.end'));
      });

      // Message 1: speech.config
      const config = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: false,
                wordBoundaryEnabled: true,
              },
              outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
            },
          },
        },
      });
      ws.send(
        `X-Timestamp:${dateHeader()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        config,
      );

      // Message 2: SSML
      ws.send(
        `X-RequestId:${uuidNoDashes()}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${dateHeader()}\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml,
      );
    });
  },
};
