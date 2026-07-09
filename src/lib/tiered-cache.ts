import type { CacheEntry, CacheKey, CacheLayer, CacheStats } from '../types';
import { MemoryCache } from './memory-cache';
import { IndexedDBCache } from './indexeddb-cache';

export class TieredCache implements CacheLayer {
  private layers: CacheLayer[];

  constructor(layers?: CacheLayer[]) {
    this.layers = layers ?? [new MemoryCache(), new IndexedDBCache()];
  }

  async get<T>(key: CacheKey): Promise<CacheEntry<T> | null> {
    for (let i = 0; i < this.layers.length; i++) {
      const entry = await this.layers[i].get<T>(key);
      if (entry) {
        // Promote to higher layers
        for (let j = 0; j < i; j++) {
          await this.layers[j].put(key, entry.value, entry.ttlMs);
        }
        return entry;
      }
    }
    return null;
  }

  async put<T>(key: CacheKey, value: T, ttlMs: number): Promise<void> {
    // Write to all layers
    await Promise.all(this.layers.map(l => l.put(key, value, ttlMs)));
  }

  async delete(key: CacheKey): Promise<void> {
    await Promise.all(this.layers.map(l => l.delete(key)));
  }

  async clear(): Promise<void> {
    await Promise.all(this.layers.map(l => l.clear()));
  }

  stats(): CacheStats {
    // Return stats from first layer (most relevant)
    return this.layers[0].stats();
  }
}
