import { buildSSML } from './ssml-builder';
import type { TTSEngine } from './types';

// Edge TTS uses a WebSocket API at speech.platform.bing.com
// We construct the WS URL with a token obtained from the token endpoint

const EDGE_TTS_WS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_TTS_TOKEN_URL = 'https://edge.microsoft.com/translate/auth';

interface EdgeWordBoundary {
  wordIndex: number;
  text: string;
  offsetMs: number;
  durationMs: number;
}

export const edgeTTS: TTSEngine = {
  async synthesize(text: string, voiceId: string, speed: number): Promise<{
    audio: ArrayBuffer;
    words: EdgeWordBoundary[];
    durationMs: number;
  }> {
    const ssml = buildSSML(text, voiceId, speed);

    // Get auth token
    const tokenResp = await fetch(EDGE_TTS_TOKEN_URL);
    const token = await tokenResp.text();

    // Connect WebSocket
    const wsUrl = `${EDGE_TTS_WS_URL}?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${crypto.randomUUID()}`;

    // Cloudflare Workers support WebSocket client via `fetch` upgrade
    const wsResp = await fetch(wsUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Upgrade': 'websocket',
      },
    });

    const ws = wsResp.webSocket;
    if (!ws) {
      throw new Error('Failed to establish WebSocket connection to Edge TTS');
    }

    return new Promise((resolve, reject) => {
      const audioChunks: Uint8Array[] = [];
      const words: EdgeWordBoundary[] = [];
      let wordCounter = 0;

      ws.addEventListener('open', () => {
        // Send config
        ws.send(JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataOptions: {
                  sentenceBoundaryEnabled: 'false',
                  wordBoundaryEnabled: 'true',
                },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        }));
        // Send SSML
        ws.send(ssml);
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as string;
        if (data.startsWith('Path:audio')) {
          // Binary audio follows after the header line
          // In CF Workers, binary frames come as ArrayBuffer
          return;
        }
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'audio' && msg.data) {
            // Binary audio chunk (base64 in some implementations)
            const binary = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
            audioChunks.push(binary);
          } else if (msg.type === 'WordBoundary') {
            // Offset is in 100-nanosecond units, convert to ms
            const offsetMs = Math.round(msg.offset / 10000);
            const durationMs = Math.round(msg.duration / 10000);
            words.push({
              wordIndex: wordCounter++,
              text: msg.text,
              offsetMs,
              durationMs,
            });
          } else if (msg.type === 'turn.end') {
            // Synthesis complete
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
            ws.close();
            resolve({ audio: audio.buffer, words, durationMs });
          }
        } catch {
          // Binary data — could be raw audio bytes
          if (event.data instanceof ArrayBuffer) {
            audioChunks.push(new Uint8Array(event.data));
          }
        }
      });

      ws.addEventListener('error', () => {
        reject(new Error('Edge TTS WebSocket error'));
      });

      // Timeout after 25s (CF Worker limit is 30s)
      setTimeout(() => {
        ws.close();
        reject(new Error('Edge TTS timeout'));
      }, 25000);
    });
  },
};
