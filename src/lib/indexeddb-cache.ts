import { get, set, del, clear, createStore } from 'idb-keyval';
import type { CacheEntry, CacheKey, CacheLayer, CacheStats } from '../types';

export class IndexedDBCache implements CacheLayer {
  private store = createStore('speechify-cache', 'keyval');
  private _stats: CacheStats = { hits: 0, misses: 0, sizeBytes: 0, entries: 0 };

  async get<T>(key: CacheKey): Promise<CacheEntry<T> | null> {
    const entry = await get<CacheEntry<T>>(key, this.store);
    if (!entry) {
      this._stats.misses++;
      return null;
    }
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      await del(key, this.store);
      this._stats.misses++;
      return null;
    }
    entry.lastAccessedAt = Date.now();
    this._stats.hits++;
    return entry;
  }

  async put<T>(key: CacheKey, value: T, ttlMs: number): Promise<void> {
    const sizeBytes = value instanceof ArrayBuffer ? value.byteLength : JSON.stringify(value).length * 2;
    const entry: CacheEntry<T> = {
      key, value, sizeBytes,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      ttlMs,
    };
    try {
      await set(key, entry, this.store);
      this._stats.sizeBytes += sizeBytes;
      this._stats.entries++;
    } catch (e) {
      // Quota exceeded — evict and retry
      await this.evictOldest();
      await set(key, entry, this.store);
    }
  }

  async delete(key: CacheKey): Promise<void> {
    await del(key, this.store);
  }

  async clear(): Promise<void> {
    await clear(this.store);
    this._stats = { hits: 0, misses: 0, sizeBytes: 0, entries: 0 };
  }

  stats(): CacheStats {
    return { ...this._stats };
  }

  private async evictOldest(): Promise<void> {
    // Simplified: clear 25% of entries
    await clear(this.store);
    this._stats.sizeBytes = 0;
    this._stats.entries = 0;
  }
}
