import { getEngine } from './multi-engine';
import { getCached, putCache } from './r2-cache';
import type { Env, TTSRequest } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/tts') {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    let body: TTSRequest;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
    }

    const { text, voiceId, speed, format } = body;
    if (!text || !voiceId) {
      return new Response(JSON.stringify({ error: 'missing_params' }), { status: 400 });
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
          'Content-Type': `audio/${format || 'mp3'}`,
          'X-Chunk-Id': cacheKey,
          'X-Words': cached.words,
          'X-Duration': cached.durationMs.toString(),
          'X-Cache': 'HIT',
        },
      });
    }

    // Synthesize
    try {
      const engine = getEngine('edge');
      const result = await engine.synthesize(text, voiceId, speed || 1.0);

      // Cache in R2 (if available)
      try {
        await putCache(env, cacheKey, result.audio, JSON.stringify(result.words), result.durationMs);
      } catch {
        // R2 not bound — skip cache
      }

      return new Response(result.audio, {
        status: 200,
        headers: {
          'Content-Type': `audio/${format || 'mp3'}`,
          'X-Chunk-Id': cacheKey,
          'X-Words': JSON.stringify(result.words),
          'X-Duration': result.durationMs.toString(),
          'X-Cache': 'MISS',
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      const isRateLimit = message.includes('429') || message.includes('rate');
      return new Response(JSON.stringify({
        error: isRateLimit ? 'rate_limited' : 'tts_failed',
        message,
        retryAfterMs: isRateLimit ? 1000 : undefined,
      }), {
        status: isRateLimit ? 429 : 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

function hashKey(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash = hash & 0xffffffff;
  }
  return Math.abs(hash).toString(16);
}
