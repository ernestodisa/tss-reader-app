import type { Env } from './types';

export async function getCached(env: Env, key: string): Promise<{ audio: ArrayBuffer; words: string; durationMs: number } | null> {
  if (!env.TTS_CACHE) return null;
  const obj = await env.TTS_CACHE.get(`tts:${key}`);
  if (!obj) return null;
  const words = obj.customMetadata?.words || '[]';
  const durationMs = parseInt(obj.customMetadata?.durationMs || '0', 10);
  const audio = await obj.arrayBuffer();
  return { audio, words, durationMs };
}

export async function putCache(
  env: Env,
  key: string,
  audio: ArrayBuffer,
  words: string,
  durationMs: number,
): Promise<void> {
  if (!env.TTS_CACHE) return;
  await env.TTS_CACHE.put(`tts:${key}`, audio, {
    customMetadata: { words, durationMs: durationMs.toString() },
    // R2 TTL not available on free plan; entries are evicted by LRU in client
  });
}
