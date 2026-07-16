import { resolveEngine, isEngineConfigured, listEngines } from './multi-engine';
import { getCached, putCache } from './r2-cache';
import type { Env, EngineId, TTSRequest } from './types';

const MAX_TEXT_LENGTH = 2000;
const MAX_SYNC_BYTES = 64 * 1024; // 64KB per sync payload
const SYNC_CODE_RE = /^[A-Za-z0-9]{8,32}$/;
const VALID_ENGINES: EngineId[] = ['edge', 'elevenlabs', 'openai'];

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'X-Words, X-Duration, X-Chunk-Id, X-Cache',
  };
}

function jsonError(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight — advertise every method the API exposes.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          ...corsHeaders(),
          'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // GET /engines — list engines and their representative voices.
    if (url.pathname === '/engines') {
      if (request.method !== 'GET') return jsonError(405, { error: 'method_not_allowed' });
      return jsonOk({ engines: listEngines(env) });
    }

    // GET|PUT /sync/{code} — best-effort cross-device progress sync (see below).
    if (url.pathname.startsWith('/sync/')) {
      return handleSync(request, env, url);
    }

    // POST /tts — text-to-speech.
    if (url.pathname === '/tts') {
      if (request.method !== 'POST') return jsonError(405, { error: 'method_not_allowed' });
      return handleTTS(request, env);
    }

    return jsonError(404, { error: 'not_found' });
  },
};

async function handleTTS(request: Request, env: Env): Promise<Response> {
  let body: TTSRequest;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, { error: 'invalid_json' });
  }

  const { text, voiceId, speed, format } = body;
  if (!text || !voiceId) {
    return jsonError(400, { error: 'missing_params' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return jsonError(400, { error: 'text_too_long', maxLength: MAX_TEXT_LENGTH });
  }

  // Resolve engine (default edge). Unknown engine → 400; known-but-unconfigured → 400.
  const engineName: EngineId = body.engine ?? 'edge';
  if (!VALID_ENGINES.includes(engineName)) {
    return jsonError(400, { error: 'unknown_engine', engine: engineName });
  }
  if (!isEngineConfigured(engineName, env)) {
    return jsonError(400, { error: 'engine_not_configured', engine: engineName });
  }
  const engine = resolveEngine(engineName, env);
  if (!engine) {
    return jsonError(400, { error: 'engine_not_configured', engine: engineName });
  }

  // Cache key includes the engine so different engines never collide.
  const cacheKey = `${engineName}::${hashKey(text)}::${voiceId}::${speed}`;

  // Check R2 cache (if available)
  let cached = null;
  try {
    cached = await getCached(env, cacheKey);
  } catch {
    // R2 not bound — skip cache
  }
  if (cached) {
    return new Response(cached.audio, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': `audio/${format || 'mp3'}`,
        'X-Chunk-Id': cacheKey,
        'X-Words': encodeWordsHeader(cached.words),
        'X-Duration': cached.durationMs.toString(),
        'X-Cache': 'HIT',
      },
    });
  }

  // Synthesize
  try {
    const result = await engine.synthesize(text, voiceId, speed || 1.0);

    const encodedWords = encodeURIComponent(JSON.stringify(result.words));

    // Cache in R2 (if available) — words stored already URI-encoded
    try {
      await putCache(env, cacheKey, result.audio, encodedWords, result.durationMs);
    } catch {
      // R2 not bound — skip cache
    }

    return new Response(result.audio, {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': `audio/${format || 'mp3'}`,
        'X-Chunk-Id': cacheKey,
        'X-Words': encodedWords,
        'X-Duration': result.durationMs.toString(),
        'X-Cache': 'MISS',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error';
    const isRateLimit = message.includes('429') || message.includes('rate');
    return jsonError(isRateLimit ? 429 : 500, {
      error: isRateLimit ? 'rate_limited' : 'tts_failed',
      message,
      retryAfterMs: isRateLimit ? 1000 : undefined,
    });
  }
}

// Best-effort progress sync by shared code. TRADEOFF: there is NO auth — anyone
// who knows a code can read or overwrite that code's progress. The code is a
// shared secret chosen by the user (8–32 alphanumerics); treat it like a
// bookmark, not a credential. Do not store anything sensitive here. Payloads
// are capped at 64KB and stored under sync/{code} in the same R2 bucket.
async function handleSync(request: Request, env: Env, url: URL): Promise<Response> {
  const code = decodeURIComponent(url.pathname.slice('/sync/'.length));
  if (!SYNC_CODE_RE.test(code)) {
    return jsonError(400, { error: 'invalid_sync_code' });
  }
  if (!env.TTS_CACHE) {
    return jsonError(503, { error: 'sync_unavailable' });
  }
  const objKey = `sync/${code}`;

  if (request.method === 'GET') {
    const obj = await env.TTS_CACHE.get(objKey);
    if (!obj) return jsonError(404, { error: 'not_found' });
    const data = await obj.text();
    return new Response(data, {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  if (request.method === 'PUT') {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_SYNC_BYTES) {
      return jsonError(413, { error: 'payload_too_large', maxBytes: MAX_SYNC_BYTES });
    }
    // Validate it is JSON before persisting.
    try {
      JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return jsonError(400, { error: 'invalid_json' });
    }
    await env.TTS_CACHE.put(objKey, raw, {
      httpMetadata: { contentType: 'application/json' },
    });
    return jsonOk({ ok: true, code });
  }

  return jsonError(405, { error: 'method_not_allowed' });
}

// Words are stored/served URI-encoded. Legacy cache entries may hold raw
// JSON — encode those on the way out so the header is always Latin-1 safe.
function encodeWordsHeader(words: string): string {
  if (words.startsWith('%5B')) return words; // already encoded ("[")
  return encodeURIComponent(words);
}

function hashKey(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash = hash & 0xffffffff;
  }
  return Math.abs(hash).toString(16);
}
