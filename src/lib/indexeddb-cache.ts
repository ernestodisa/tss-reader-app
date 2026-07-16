import { get, set, del, clear, keys, createStore } from 'idb-keyval';
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
      this._stats.sizeBytes += sizeBytes;
      this._stats.entries++;
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
    // Evict the least-recently-accessed 25% of entries (LRU)
    try {
      const allKeys = await keys<CacheKey>(this.store);
      if (allKeys.length === 0) return;

      const entries: { key: CacheKey; lastAccessedAt: number; sizeBytes: number }[] = [];
      for (const k of allKeys) {
        const entry = await get<CacheEntry<unknown>>(k, this.store);
        if (entry) {
          entries.push({ key: k, lastAccessedAt: entry.lastAccessedAt, sizeBytes: entry.sizeBytes });
        }
      }

      entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
      const evictCount = Math.max(1, Math.ceil(entries.length * 0.25));
      for (const { key, sizeBytes } of entries.slice(0, evictCount)) {
        await del(key, this.store);
        this._stats.sizeBytes = Math.max(0, this._stats.sizeBytes - sizeBytes);
        this._stats.entries = Math.max(0, this._stats.entries - 1);
      }
    } catch {
      // Fallback: nuke everything if LRU eviction itself fails
      await clear(this.store);
      this._stats.sizeBytes = 0;
      this._stats.entries = 0;
    }
  }
}
