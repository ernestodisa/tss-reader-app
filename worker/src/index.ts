import { resolveEngine, isEngineConfigured, listEngines } from './multi-engine';
import { getCached, putCache } from './r2-cache';
import type { Env, EngineId, TTSRequest } from './types';

const MAX_TEXT_LENGTH = 2000;
const MAX_SYNC_BYTES = 64 * 1024; // 64KB per sync payload (progreso)
// Libros completos (ExtractedDoc JSON + portada dataURL): tope generoso pero
// acotado para no convertir el bucket en almacenamiento arbitrario.
const MAX_BOOK_BYTES = 8 * 1024 * 1024; // 8MB por libro
const SYNC_CODE_RE = /^[A-Za-z0-9]{8,32}$/;
// bookId lo genera library-store (`epub-<título>-<ts>`): puede llevar espacios
// y acentos. Se acepta cualquier cosa sin '/' y de tamaño razonable.
const BOOK_ID_OK = (id: string) => id.length > 0 && id.length <= 256 && !id.includes('/');
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
  // Rutas: /sync/{code} (progreso) y /sync/{code}/book/{bookId} (libro completo).
  const segments = url.pathname.slice('/sync/'.length).split('/').map(decodeURIComponent);
  const code = segments[0] ?? '';

  // Sincronización por identidad (email del JWT de Access). Las rutas /sync/me y
  // /sync/me/book/{bookId} son el equivalente por-usuario de las rutas por
  // código: misma semántica, pero la llave R2 usa el email verificado en lugar
  // del código compartido. El email lo inyecta la Pages Function como
  // X-Verified-Email tras validar el JWT; el cliente nunca puede ponerlo.
  if (code === 'me') {
    return handleSyncMe(request, env, segments);
  }

  if (!SYNC_CODE_RE.test(code)) {
    return jsonError(400, { error: 'invalid_sync_code' });
  }
  if (!env.TTS_CACHE) {
    return jsonError(503, { error: 'sync_unavailable' });
  }

  if (segments.length > 1) {
    if (segments[1] !== 'book' || segments.length !== 3 || !BOOK_ID_OK(segments[2])) {
      return jsonError(404, { error: 'not_found' });
    }
    return handleSyncBook(request, env, code, segments[2]);
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

// Libro completo bajo sync/{code}/book/{bookId}: el ExtractedDoc serializado
// (texto + capítulos + portada dataURL). Mismo modelo de confianza que el
// progreso: el código es el secreto compartido.
async function handleSyncBook(
  request: Request,
  env: Env,
  code: string,
  bookId: string,
): Promise<Response> {
  const objKey = `sync/${code}/book/${bookId}`;
  const bucket = env.TTS_CACHE!;

  if (request.method === 'GET') {
    const obj = await bucket.get(objKey);
    if (!obj) return jsonError(404, { error: 'not_found' });
    return new Response(obj.body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  if (request.method === 'PUT') {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_BOOK_BYTES) {
      return jsonError(413, { error: 'payload_too_large', maxBytes: MAX_BOOK_BYTES });
    }
    try {
      JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return jsonError(400, { error: 'invalid_json' });
    }
    await bucket.put(objKey, raw, {
      httpMetadata: { contentType: 'application/json' },
    });
    return jsonOk({ ok: true, code, bookId });
  }

  return jsonError(405, { error: 'method_not_allowed' });
}

// Sincronización por identidad: /sync/me (progreso) y /sync/me/book/{bookId}
// (libro completo). El email es el segmento de confianza; llega SOLO por el
// header X-Verified-Email que inyecta la Pages Function tras validar el JWT de
// Access. En dev local (`wrangler dev`) sin Access delante, si no viene el
// header se acepta env.DEV_FAKE_EMAIL como fallback (definir como var; NUNCA en
// producción). La llave R2 vive bajo sync/u/{email} — namespace separado de las
// rutas por código sync/{code}, que siguen intactas como fallback.
async function handleSyncMe(request: Request, env: Env, segments: string[]): Promise<Response> {
  const headerEmail = request.headers.get('X-Verified-Email');
  const rawEmail = (headerEmail && headerEmail.trim()) || (env.DEV_FAKE_EMAIL || '').trim();
  if (!rawEmail) {
    return jsonError(401, { error: 'no_autenticado' });
  }
  const email = rawEmail.toLowerCase();

  if (!env.TTS_CACHE) {
    return jsonError(503, { error: 'sync_unavailable' });
  }

  // /sync/me/book/{bookId} — libro completo del usuario.
  if (segments.length > 1) {
    if (segments[1] !== 'book' || segments.length !== 3 || !BOOK_ID_OK(segments[2])) {
      return jsonError(404, { error: 'not_found' });
    }
    return syncJsonObject(request, env, `sync/u/${email}/book/${segments[2]}`, MAX_BOOK_BYTES);
  }

  // /sync/me — progreso del usuario.
  return syncJsonObject(request, env, `sync/u/${email}`, MAX_SYNC_BYTES);
}

// GET/PUT de un objeto JSON en R2 con tope de tamaño — semántica compartida por
// las rutas por identidad (misma que las rutas por código: GET devuelve el JSON
// o 404, PUT valida JSON + tope y persiste, otros métodos → 405).
async function syncJsonObject(
  request: Request,
  env: Env,
  objKey: string,
  maxBytes: number,
): Promise<Response> {
  const bucket = env.TTS_CACHE!;

  if (request.method === 'GET') {
    const obj = await bucket.get(objKey);
    if (!obj) return jsonError(404, { error: 'not_found' });
    return new Response(obj.body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  if (request.method === 'PUT') {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > maxBytes) {
      return jsonError(413, { error: 'payload_too_large', maxBytes });
    }
    try {
      JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return jsonError(400, { error: 'invalid_json' });
    }
    await bucket.put(objKey, raw, {
      httpMetadata: { contentType: 'application/json' },
    });
    return jsonOk({ ok: true });
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
