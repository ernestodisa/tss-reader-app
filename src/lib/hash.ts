// Simple synchronous hash (djb2) — sufficient for cache keys
export function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash = hash & 0xffffffff; // Force 32-bit
  }
  return Math.abs(hash).toString(16);
}

export function chunkId(text: string, voiceId: string, speed: number): string {
  return hashString(`${text}::${voiceId}::${speed}`);
}
