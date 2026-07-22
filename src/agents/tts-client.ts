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

// ── Dedupe de fetches en vuelo (M16) ─────────────────────────────────────
// Si varios caminos piden el MISMO chunk a la vez (reproducción del chunk +
// queueUpcoming + prefetch + descarga offline del capítulo que se escucha) sin
// dedupe se disparan 3-4 POST idénticos contra el Edge TTS frágil → 429. Aquí
// comparten UN solo POST por chunk. Refcount de "interesados": el POST solo se
// aborta de verdad (AbortController interno) cuando NADIE lo espera ya. Esto
// resuelve a la vez B8 (el "Cancelar" de una descarga aborta el request de red
// cuando es suyo) SIN el efecto colateral de matar el mismo chunk si además lo
// está pidiendo la reproducción — el fetch compartido no está atado al signal
// de un solo caller, así que cancelar la descarga no puede tumbar el audio.
interface InflightFetch {
  promise: Promise<AgentResult<TTSResponse>>;
  controller: AbortController;
  waiters: number;
}
const inflight = new Map<string, InflightFetch>();

function abortedResult(chunkId: string): AgentResult<TTSResponse> {
  return {
    success: false,
    error: { step: 'tts', chunkId, code: 'aborted', message: 'fetch cancelado', recoverable: false },
  };
}

// ── Public API ──────────────────────────────────────────────────────────

/** ¿Este chunk ya está completo en cache (audio crudo + timings)? Lo usa la
 *  descarga offline por capítulo para saber qué falta sin pegar a la red. */
export async function hasCachedChunk(chunkId: string): Promise<boolean> {
  const raw = await rawAudioCache.get<RawAudioEntry>(`raw:${chunkId}`);
  if (!raw || raw.value.audio.byteLength === 0) return false;
  const timings = await useCacheStore.getState().getTimings(chunkId);
  return !!timings;
}

export async function fetchTTS(
  chunk: TTSChunk,
  signal?: AbortSignal,
): Promise<AgentResult<TTSResponse>> {
  // 1. Check client-side cache ─────────────────────────────────────────
  const cachedRaw = await rawAudioCache.get<RawAudioEntry>(`raw:${chunk.id}`);
  const cachedTimings = await useCacheStore.getState().getTimings(chunk.id);

  // Entradas envenenadas por el bug del audio vacío (cacheadas ANTES del guard
  // de abajo): se purgan aquí para que los dispositivos afectados se curen
  // solos — el miss resultante vuelve a la red por bytes frescos.
  if (cachedRaw && cachedRaw.value.audio.byteLength === 0) {
    await rawAudioCache.delete(`raw:${chunk.id}`);
  } else if (cachedRaw && cachedTimings) {
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

  // 2. Red con dedupe (M16) + abort real (B8) ──────────────────────────
  if (signal?.aborted) return abortedResult(chunk.id);

  let entry = inflight.get(chunk.id);
  if (!entry) {
    const controller = new AbortController();
    const created: InflightFetch = {
      promise: fetchTTSFromNetwork(chunk, controller.signal),
      controller,
      waiters: 0,
    };
    inflight.set(chunk.id, created);
    // La entrada sale del mapa al terminar (éxito, error o abort): el próximo
    // fetch del mismo chunk arranca fresco y nunca reusa una promesa muerta.
    void created.promise.finally(() => {
      if (inflight.get(chunk.id) === created) inflight.delete(chunk.id);
    });
    entry = created;
  }
  const active = entry;
  active.waiters++;

  const release = (): void => {
    active.waiters--;
    // Nadie más espera este chunk → aborta el POST en vuelo (no satura Edge TTS).
    if (active.waiters <= 0) active.controller.abort();
  };

  // Caller sin signal (reproducción, prefetch, queueUpcoming): espera directa.
  if (!signal) {
    try {
      return await active.promise;
    } finally {
      release();
    }
  }

  // Caller con signal (descarga offline): puede cancelar SU espera al instante;
  // si resulta ser el último interesado, `release()` aborta el POST compartido.
  const sig = signal; // captura para que TS no lo ensanche dentro del closure
  return await new Promise<AgentResult<TTSResponse>>((resolve) => {
    let settled = false;
    function onAbort(): void {
      finish(abortedResult(chunk.id));
    }
    function finish(r: AgentResult<TTSResponse>): void {
      if (settled) return;
      settled = true;
      sig.removeEventListener('abort', onAbort);
      release();
      resolve(r);
    }
    sig.addEventListener('abort', onAbort);
    void active.promise.then(finish, () => finish(abortedResult(chunk.id)));
  });
}

/** Un solo POST /tts sin dedupe. `signal` es el del AbortController interno del
 *  dedupe: al abortarse, `fetch` lanza y el catch de red devuelve un error
 *  recuperable SIN cachear nada (el chunk abortado no envenena el cache). */
async function fetchTTSFromNetwork(
  chunk: TTSChunk,
  signal: AbortSignal,
): Promise<AgentResult<TTSResponse>> {
  try {
    const resp = await fetch(`${WORKER_URL}/tts`, {
      signal,
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

    // Edge TTS ocasionalmente responde 200 con cuerpo VACÍO o truncado (upstream
    // frágil). Un ArrayBuffer de 0 bytes decodifica a un <audio> con error 4 /
    // duration NaN: no suena, no dispara `ended`, y la reproducción se queda
    // muerta o (si es un párrafo multi-chunk) avanza/pausa en falso — sin error
    // en consola ni toast. Peor aún: si se cachea, cada reintento es un cache-hit
    // del audio vacío → el fallo se vuelve DETERMINISTA y no vuelve a salir un
    // POST. Lo tratamos como error RECUPERABLE ANTES de cachear nada: así el
    // reintento con backoff pega de nuevo a la red (bytes frescos) y el cache
    // nunca se envenena.
    if (audio.byteLength === 0) {
      return {
        success: false,
        error: {
          step: 'tts',
          chunkId: chunk.id,
          code: 'empty_audio',
          message: 'TTS devolvió audio vacío (0 bytes)',
          recoverable: true,
          retryAfterMs: 800,
        },
      };
    }

    // B12: además de 0 bytes, rechaza cuerpos que NO son MP3. Edge TTS a veces
    // responde 200 con un cuerpo de error/no-audio o con bytes basura; cachearlo
    // lo vuelve un fallo DETERMINISTA 30 días (la purga solo cura 0-bytes). Señal
    // barata y agnóstica del engine: todo MP3 válido empieza con un frame sync
    // MPEG (0xFF, y el 2º byte con los 3 bits altos en 1 → 0xEx/0xFx) o con una
    // etiqueta ID3 ("ID3", que sí antepone OpenAI). Si no aparece ninguno, es
    // basura → error RECUPERABLE ANTES de cachear (mismo patrón que 0-bytes).
    // FALSO-NEGATIVO RESIDUAL DOCUMENTADO: un MP3 con cabecera válida pero
    // truncado a media reproducción SÍ pasa este guard — detectarlo exigiría
    // parsear frames o asumir un bitrate por engine (frágil con multi-engine),
    // así que se acepta el trade-off a favor de una heurística O(1) sin falsos
    // positivos.
    const head = new Uint8Array(audio, 0, Math.min(3, audio.byteLength));
    const isId3 = head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
    const isMpegSync = head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
    if (!isId3 && !isMpegSync) {
      return {
        success: false,
        error: {
          step: 'tts',
          chunkId: chunk.id,
          code: 'empty_audio',
          message: 'TTS devolvió un cuerpo sin cabecera MP3 válida (¿no-audio/truncado?)',
          recoverable: true,
          retryAfterMs: 800,
        },
      };
    }

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
