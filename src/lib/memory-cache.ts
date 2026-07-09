import type { CacheEntry, CacheKey, CacheLayer, CacheStats } from '../types';

const MAX_ENTRIES = 100;

export class MemoryCache implements CacheLayer {
  private map = new Map<CacheKey, CacheEntry<unknown>>();
  private _stats: CacheStats = { hits: 0, misses: 0, sizeBytes: 0, entries: 0 };

  async get<T>(key: CacheKey): Promise<CacheEntry<T> | null> {
    const entry = this.map.get(key) as CacheEntry<T> | undefined;
    if (!entry) {
      this._stats.misses++;
      return null;
    }
    // Move to end (most recently used)
    this.map.delete(key);
    entry.lastAccessedAt = Date.now();
    this.map.set(key, entry);
    this._stats.hits++;
    return entry;
  }

  async put<T>(key: CacheKey, value: T, ttlMs: number): Promise<void> {
    // Evict oldest if at capacity
    while (this.map.size >= MAX_ENTRIES) {
      const oldestKey = this.map.keys().next().value as CacheKey;
      const evicted = this.map.get(oldestKey);
      if (evicted) this._stats.sizeBytes -= evicted.sizeBytes;
      this.map.delete(oldestKey);
    }
    const sizeBytes = estimateSize(value);
    const entry: CacheEntry<T> = {
      key, value, sizeBytes,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      ttlMs,
    };
    this.map.set(key, entry);
    this._stats.sizeBytes += sizeBytes;
    this._stats.entries = this.map.size;
  }

  async delete(key: CacheKey): Promise<void> {
    const entry = this.map.get(key);
    if (entry) this._stats.sizeBytes -= entry.sizeBytes;
    this.map.delete(key);
    this._stats.entries = this.map.size;
  }

  async clear(): Promise<void> {
    this.map.clear();
    this._stats.sizeBytes = 0;
    this._stats.entries = 0;
  }

  stats(): CacheStats {
    return { ...this._stats };
  }
}

function estimateSize(value: unknown): number {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value === 'string') return value.length * 2;
  try { return JSON.stringify(value).length * 2; } catch { return 1024; }
}
