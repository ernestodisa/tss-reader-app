import { useCacheStore } from '../store/cache-store';
import { TieredCache } from '../lib/tiered-cache';

import type { AgentResult, TTSChunk, TTSResponse, WordTiming } from '../types';

// ── Worker URL (configurable via Vite env) ──────────────────────────────
const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787';

// ── Raw-audio cache ─────────────────────────────────────────────────────
// A separate TieredCache stores the original MP3/OGG ArrayBuffer + duration
// so that cache hits can return pristine audio bytes without re-decoding.
const rawAudioCache = new TieredCache();
const RAW_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

interface RawAudioEntry {
  audio: ArrayBuffer;
  durationMs: number;
}

// ── Public API ──────────────────────────────────────────────────────────

/** ¿Este chunk ya está completo en cache (audio crudo + timings)? Lo usa la
 *  descarga offline por capítulo para saber qué falta sin pegar a la red. */
export async function hasCachedChunk(chunkId: string): Promise<boolean> {
  const raw = await rawAudioCache.get<RawAudioEntry>(`raw:${chunkId}`);
  if (!raw) return false;
  const timings = await useCacheStore.getState().getTimings(chunkId);
  return !!timings;
}

export async function fetchTTS(chunk: TTSChunk): Promise<AgentResult<TTSResponse>> {
  // 1. Check client-side cache ─────────────────────────────────────────
  const cachedRaw = await rawAudioCache.get<RawAudioEntry>(`raw:${chunk.id}`);
  const cachedTimings = await useCacheStore.getState().getTimings(chunk.id);

  if (cachedRaw && cachedTimings) {
    return {
      success: true,
      data: {
        chunkId: chunk.id,
        audio: cachedRaw.value.audio,
        format: 'mp3',
        words: cachedTimings,
        durationMs: cachedRaw.value.durationMs,
      },
    };
  }

  // 2. Fetch from Worker ────────────────────────────────────────────────
  try {
    const resp = await fetch(`${WORKER_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: chunk.text,
        voiceId: chunk.voiceId,
        engine: chunk.engine,
        speed: chunk.speed,
        format: 'mp3',
      }),
    });

    // ── Rate-limited (429) ───────────────────────────────────────────
    if (resp.status === 429) {
      const body = await resp.json().catch(() => ({}));
      return {
        success: false,
        error: {
          step: 'tts',
          chunkId: chunk.id,
          code: 'rate_limited',
          message: 'Edge TTS rate limited. Reintentando...',
          recoverable: true,
          retryAfterMs: body.retryAfterMs || 1000,
        },
      };
    }

    // ── Other errors ─────────────────────────────────────────────────
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return {
        success: false,
        error: {
          step: 'tts',
          chunkId: chunk.id,
          code: 'tts_failed',
          message: body.message || `HTTP ${resp.status}`,
          recoverable: false,
        },
      };
    }

    // ── Success: parse response ──────────────────────────────────────
    const audio = await resp.arrayBuffer();
    const wordsHeader = resp.headers.get('X-Words') || '[]';
    const durationMs = parseInt(resp.headers.get('X-Duration') || '0', 10);
    // Worker sends X-Words URI-encoded (Latin-1-safe); fall back to raw JSON
    // for compatibility with older worker responses.
    let words: WordTiming[];
    try {
      words = JSON.parse(decodeURIComponent(wordsHeader));
    } catch {
      words = JSON.parse(wordsHeader);
    }

    // Store raw MP3 bytes so future cache hits can return pristine audio.
    // (El player reproduce MP3 crudo en <audio>; ya no se decodifica a PCM
    // ni se llena la capa putAudio del cache-store — nadie la lee.)
    await rawAudioCache.put(`raw:${chunk.id}`, { audio, durationMs } as RawAudioEntry, RAW_TTL);

    // Store word timings
    await useCacheStore.getState().putTimings(chunk.id, words);

    return {
      success: true,
      data: {
        chunkId: chunk.id,
        audio,
        format: 'mp3',
        words,
        durationMs,
      },
    };
  } catch (err) {
    // ── Network / unexpected errors ──────────────────────────────────
    return {
      success: false,
      error: {
        step: 'tts',
        chunkId: chunk.id,
        code: 'network_error',
        message: err instanceof Error ? err.message : 'network error',
        recoverable: true,
        retryAfterMs: 2000,
      },
    };
  }
}
