import { get, set, del, clear, keys, createStore } from 'idb-keyval';
import type { CacheEntry, CacheKey, CacheLayer, CacheStats } from '../types';
import { migrationReady } from './rebrand-migration';

// Exportado para la migración de re-branding (rebrand-migration.ts).
export const idbCacheStore = createStore('folio-cache', 'keyval');

export class IndexedDBCache implements CacheLayer {
  private store = idbCacheStore;
  private _stats: CacheStats = { hits: 0, misses: 0, sizeBytes: 0, entries: 0 };

  async get<T>(key: CacheKey): Promise<CacheEntry<T> | null> {
    // M14: no leer el cache TTS antes de que la migración IDB haya copiado (o
    // expirado su timeout); de lo contrario un chunk pre-rebrand se leería como
    // miss y se re-descargaría. Post-migración la promesa ya está resuelta.
    await migrationReady;
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

  // Ventana de "recién tocado": los chunks accedidos/escritos hace menos de esto
  // se protegen de la evicción LRU. Durante una descarga de capítulo (o la
  // lectura en curso) los chunks recién puestos tienen lastAccessedAt muy fresco;
  // si la evicción los tirara, `hasCachedChunk` reportaría el capítulo como
  // no-bajado y la descarga jamás cerraría, o "✓ listo sin conexión" sería falso
  // (M15). Heurística simple: excluir < RECENT_MS del set de candidatos.
  private static readonly RECENT_MS = 60_000;

  private async evictOldest(): Promise<void> {
    // Evict the least-recently-accessed 25% of entries (LRU), protegiendo los
    // recién tocados (ver RECENT_MS).
    try {
      const allKeys = await keys<CacheKey>(this.store);
      if (allKeys.length === 0) return;

      const now = Date.now();
      const entries: { key: CacheKey; lastAccessedAt: number; sizeBytes: number }[] = [];
      for (const k of allKeys) {
        const entry = await get<CacheEntry<unknown>>(k, this.store);
        if (entry) {
          entries.push({ key: k, lastAccessedAt: entry.lastAccessedAt, sizeBytes: entry.sizeBytes });
        }
      }

      entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

      // Candidatos = entradas NO recientes. Si TODO es reciente (p.ej. una
      // descarga enorme que acaba de tocar cada chunk) no hay más remedio que
      // evictar lo más viejo para liberar espacio — mejor eso que quedarse sin
      // poder escribir; queda documentado como el único caso donde se toca algo
      // reciente.
      const notRecent = entries.filter((e) => now - e.lastAccessedAt >= IndexedDBCache.RECENT_MS);
      const pool = notRecent.length > 0 ? notRecent : entries;
      const evictCount = Math.max(1, Math.ceil(pool.length * 0.25));
      for (const { key, sizeBytes } of pool.slice(0, evictCount)) {
        await del(key, this.store);
        this._stats.sizeBytes = Math.max(0, this._stats.sizeBytes - sizeBytes);
        this._stats.entries = Math.max(0, this._stats.entries - 1);
      }
    } catch (e) {
      // NUNCA borrar todo el cache en silencio (bug M15: el fallback anterior
      // hacía clear() y se llevaba TODAS las descargas de TODOS los libros ante
      // cualquier fallo transitorio de IDB). Log + rethrow: el caller (put →
      // fetchTTSFromNetwork) decide; el peor caso es un chunk que no se cachea y
      // se re-pide, no un cache aniquilado.
      console.warn('[cache] evicción LRU falló; se propaga sin borrar el cache', e);
      throw e;
    }
  }
}
