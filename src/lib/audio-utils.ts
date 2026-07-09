let audioContext: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
  return audioContext;
}

export async function decodeAudio(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  return await ctx.decodeAudioData(arrayBuffer.slice(0));
}

/**
 * Reconstruct an AudioBuffer from the cache store's custom PCM format.
 *
 * The cache store (`bufferToArrayBuffer` in cache-store.ts) stores audio as:
 *   [channels:u32][length:u32][sampleRate:u32][ch0:f32*len][ch1:f32*len...]
 *
 * This function reverses that encoding, producing a playable AudioBuffer.
 */
export function audioBufferFromCachePCM(arrayBuffer: ArrayBuffer): AudioBuffer | null {
  try {
    const view = new DataView(arrayBuffer);
    const channels = view.getUint32(0, true);
    const length = view.getUint32(4, true);
    const sampleRate = view.getUint32(8, true);

    const ctx = getAudioContext();
    const buffer = ctx.createBuffer(channels, length, sampleRate);

    let offset = 12; // header size
    for (let ch = 0; ch < channels; ch++) {
      const channelData = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        channelData[i] = view.getFloat32(offset, true);
        offset += 4;
      }
    }
    return buffer;
  } catch {
    return null;
  }
}

export function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
