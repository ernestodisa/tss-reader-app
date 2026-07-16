import { create } from 'zustand';
import { TieredCache } from '../lib/tiered-cache';
import { audioBufferFromCachePCM } from '../lib/audio-utils';
import type { WordTiming } from '../types';

const cache = new TieredCache();
const TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

interface CacheStore {
  hits: number;
  misses: number;
  getAudio: (chunkId: string) => Promise<AudioBuffer | null>;
  putAudio: (chunkId: string, buffer: AudioBuffer) => Promise<void>;
  getTimings: (chunkId: string) => Promise<WordTiming[] | null>;
  putTimings: (chunkId: string, timings: WordTiming[]) => Promise<void>;
  clear: () => Promise<void>;
}

export const useCacheStore = create<CacheStore>((set) => ({
  hits: 0,
  misses: 0,
  getAudio: async (chunkId: string) => {
    const entry = await cache.get<ArrayBuffer>(`audio:${chunkId}`);
    if (entry) {
      const audioBuffer = audioBufferFromCachePCM(entry.value);
      if (audioBuffer) {
        set(s => ({ hits: s.hits + 1 }));
        return audioBuffer;
      }
    }
    set(s => ({ misses: s.misses + 1 }));
    return null;
  },
  putAudio: async (chunkId: string, buffer: AudioBuffer) => {
    // Store as ArrayBuffer (portable across AudioContext instances)
    const arrayBuffer = bufferToArrayBuffer(buffer);
    await cache.put(`audio:${chunkId}`, arrayBuffer, TTL);
  },
  getTimings: async (chunkId: string) => {
    const entry = await cache.get<WordTiming[]>(`timings:${chunkId}`);
    if (entry) return entry.value;
    return null;
  },
  putTimings: async (chunkId: string, timings: WordTiming[]) => {
    await cache.put(`timings:${chunkId}`, timings, TTL);
  },
  clear: async () => {
    await cache.clear();
    set({ hits: 0, misses: 0 });
  },
}));

// Helper — copy AudioBuffer to a transferable ArrayBuffer
function bufferToArrayBuffer(buffer: AudioBuffer): ArrayBuffer {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  // Store as raw PCM float32 with header
  const headerSize = 12; // channels(4) + length(4) + sampleRate(4)
  const totalSize = headerSize + channels * length * 4;
  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);
  view.setUint32(0, channels, true);
  view.setUint32(4, length, true);
  view.setUint32(8, sampleRate, true);
  let offset = headerSize;
  for (let ch = 0; ch < channels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      view.setFloat32(offset, channelData[i], true);
      offset += 4;
    }
  }
  return arrayBuffer;
}
