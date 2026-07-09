export type CacheKey = `${string}:${string}`;

export interface CacheEntry<T> {
  key: CacheKey;
  value: T;
  createdAt: number;
  lastAccessedAt: number;
  sizeBytes: number;
  ttlMs: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  sizeBytes: number;
  entries: number;
}

export interface CacheLayer {
  get<T>(key: CacheKey): Promise<CacheEntry<T> | null>;
  put<T>(key: CacheKey, value: T, ttlMs: number): Promise<void>;
  delete(key: CacheKey): Promise<void>;
  clear(): Promise<void>;
  stats(): CacheStats;
}
