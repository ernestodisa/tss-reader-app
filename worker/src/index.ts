import { getEngine } from './multi-engine';
import { getCached, putCache } from './r2-cache';
import type { Env, TTSRequest } from './types';

const MAX_TEXT_LENGTH = 2000;

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          ...corsHeaders(),
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return jsonError(405, { error: 'method_not_allowed' });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/tts') {
      return jsonError(404, { error: 'not_found' });
    }

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

    // Generate cache key
    const cacheKey = `${hashKey(text)}::${voiceId}::${speed}`;

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
      const engine = getEngine('edge');
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
  },
};

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
