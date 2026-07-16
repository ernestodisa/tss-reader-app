// Simple synchronous hash (djb2) — sufficient for cache keys
export function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash = hash & 0xffffffff; // Force 32-bit
  }
  return Math.abs(hash).toString(16);
}

// El engine forma parte de la clave: el mismo texto+voz+velocidad produce audio
// distinto según el motor (edge/elevenlabs/openai), así que no deben colisionar
// en la caché del cliente (rawAudioCache/cache-store van indexados por chunk.id).
export function chunkId(text: string, voiceId: string, speed: number, engine: string): string {
  return hashString(`${engine}::${text}::${voiceId}::${speed}`);
}
