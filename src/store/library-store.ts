import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ExtractedDoc } from '../types';

export interface LibraryEntry {
  id: string;
  title: string;
  author?: string;
  sourceType: 'pdf' | 'epub';
  totalPages?: number;
  totalCharacters: number;
  addedAt: number;
  lastReadChapter?: number;
  lastReadParagraph?: number;
  /** % leído (0-100) por caracteres, calculado en ReaderView. */
  lastReadPercent?: number;
  /** Portada reducida (dataURL JPEG) copiada de ExtractedDoc.coverDataUrl al importar.
   *  Es local-only y pesada (8–25KB): el snapshot de sync la EXCLUYE a propósito
   *  (A9) y mergeBooks la conserva por-campo si la entrada entrante no la trae. */
  coverDataUrl?: string;
  /** Marca de tiempo del último cambio de progreso; usado por sync-client para
   *  resolver conflictos entre dispositivos (gana el más reciente). Se estampa
   *  con syncedNow() para compensar relojes desfasados (M8). */
  updatedAt?: number;
  /** true cuando el CONTENIDO completo (ExtractedDoc) ya se subió a la nube por
   *  identidad; evita re-subir el libro en cada push de progreso (auto-sync). */
  bookPushed?: boolean;
}

/** Lápida de un libro borrado (M9). Viaja en el snapshot para que el borrado se
 *  propague entre dispositivos en lugar de "resucitar" en el próximo pull. */
export interface Tombstone {
  id: string;
  deletedAt: number;
}

/** Días que conservamos una lápida antes de purgarla al hacer merge. Pasado ese
 *  tiempo asumimos que todos los dispositivos ya la aplicaron. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── Reloj sincronizado (M8) ──────────────────────────────────────────────
// offset = serverNow - Date.now() local, calculado por auto-sync tras cada
// GET/PUT de /sync/me. Best-effort: NO compensa la latencia fina de la red,
// pero sí corrige relojes de dispositivo desfasados por minutos/horas, que es
// lo que provoca el retroceso silencioso de progreso en el LWW por-libro.
let clockOffsetMs = 0;

/** Ajusta el offset del reloj sincronizado. Lo llama auto-sync con el serverNow
 *  que devuelve el worker. */
export function setSyncClockOffset(offsetMs: number): void {
  if (Number.isFinite(offsetMs)) clockOffsetMs = offsetMs;
}

/** "Ahora" corregido por el offset del servidor. Usar SIEMPRE esto (no Date.now())
 *  para estampar updatedAt/deletedAt/addedAt, de modo que la comparación
 *  last-write-wins entre dispositivos use una línea de tiempo común. */
export function syncedNow(): number {
  return Date.now() + clockOffsetMs;
}

interface LibraryStore {
  books: LibraryEntry[];
  /** Lápidas de libros borrados, persistidas y propagadas por sync (M9). */
  tombstones: Tombstone[];
  addBook: (doc: ExtractedDoc) => string;
  removeBook: (id: string) => void;
  updateProgress: (id: string, chapter: number, paragraph: number, percent?: number) => void;
  /** Fusiona el snapshot remoto con lo local (merge por-campo, tombstones y
   *  last-write-wins por libro). `incomingTombstones` es opcional para
   *  compatibilidad con snapshots viejos y con el pull por-código. */
  mergeBooks: (incoming: LibraryEntry[], incomingTombstones?: Tombstone[]) => void;
  /** Marca que el contenido del libro ya se subió a la nube (auto-sync). No
   *  toca updatedAt para no disparar un push de progreso extra. */
  markBookPushed: (id: string) => void;
}

/** Fusiona dos entradas del MISMO libro (misma id) sin perder campos locales
 *  pesados/local-only. La "ganadora" (más nueva) aporta el progreso; pero si le
 *  falta un campo que la local sí tiene (coverDataUrl, bookPushed), lo
 *  conservamos — el snapshot de sync viaja SIN portadas (A9), así que un merge
 *  wholesale borraría la portada local en cada pull. */
function mergeEntry(winner: LibraryEntry, other: LibraryEntry): LibraryEntry {
  return {
    ...winner,
    coverDataUrl: winner.coverDataUrl ?? other.coverDataUrl,
    // bookPushed es una marca durable local: si CUALQUIER lado ya lo subió, no
    // reintentar (evita re-subir hasta 8MB por un merge).
    bookPushed: winner.bookPushed || other.bookPushed,
  };
}

export const useLibraryStore = create<LibraryStore>()(
  persist(
    (set) => ({
      books: [],
      tombstones: [],
      addBook: (doc: ExtractedDoc) => {
        const id = `${doc.sourceType}-${doc.title}-${Date.now()}`;
        set((s) => ({
          books: [
            ...s.books,
            {
              id,
              title: doc.title,
              author: doc.author,
              sourceType: doc.sourceType,
              totalPages: doc.totalPages,
              totalCharacters: doc.totalCharacters,
              addedAt: syncedNow(),
              coverDataUrl: doc.coverDataUrl,
            },
          ],
          // Reactivar un libro con id nuevo no debe chocar con una lápida vieja;
          // de todos modos las ids llevan timestamp, así que solo limpiamos por
          // igualdad exacta de id.
          tombstones: s.tombstones.filter((t) => t.id !== id),
        }));
        return id;
      },
      // M9: en vez de solo filtrar, dejamos una lápida para que el borrado se
      // propague por sync y el worker pueda liberar el objeto book/{id} en R2.
      removeBook: (id: string) => set((s) => ({
        books: s.books.filter(b => b.id !== id),
        tombstones: [
          ...s.tombstones.filter((t) => t.id !== id),
          { id, deletedAt: syncedNow() },
        ],
      })),
      updateProgress: (id, chapter, paragraph, percent) => set((s) => ({
        books: s.books.map(b =>
          b.id === id
            ? {
                ...b,
                lastReadChapter: chapter,
                lastReadParagraph: paragraph,
                ...(percent != null ? { lastReadPercent: percent } : {}),
                updatedAt: syncedNow(),
              }
            : b
        ),
      })),
      // Merge conservando, por id, la entrada con updatedAt/addedAt más reciente,
      // pero fusionando campos local-only (mergeEntry) y aplicando tombstones en
      // ambos sentidos. Libros que solo existen de un lado se conservan salvo que
      // una lápida más nueva los mate.
      mergeBooks: (incoming, incomingTombstones = []) => set((s) => {
        const now = syncedNow();

        // 1) Unión de lápidas (gana la más nueva por id), purgando las viejas.
        const tombById = new Map<string, Tombstone>();
        for (const t of [...s.tombstones, ...incomingTombstones]) {
          if (now - t.deletedAt > TOMBSTONE_TTL_MS) continue; // purga >30 días
          const prev = tombById.get(t.id);
          if (!prev || t.deletedAt > prev.deletedAt) tombById.set(t.id, t);
        }

        // 2) Merge por-libro.
        const byId = new Map(s.books.map((b) => [b.id, b]));
        for (const inBook of incoming) {
          const existing = byId.get(inBook.id);
          if (!existing) {
            byId.set(inBook.id, inBook);
            continue;
          }
          const existingTs = existing.updatedAt ?? existing.addedAt;
          const incomingTs = inBook.updatedAt ?? inBook.addedAt;
          const winner = incomingTs > existingTs ? inBook : existing;
          const other = incomingTs > existingTs ? existing : inBook;
          byId.set(inBook.id, mergeEntry(winner, other));
        }

        // 3) Aplicar lápidas: un libro muere si su lápida es más nueva que su
        //    último progreso local (deletedAt > updatedAt/addedAt). Si el libro
        //    se re-tocó DESPUÉS del borrado, gana la reactivación y descartamos
        //    la lápida.
        for (const [id, tomb] of tombById) {
          const book = byId.get(id);
          if (!book) continue;
          const bookTs = book.updatedAt ?? book.addedAt;
          if (tomb.deletedAt > bookTs) {
            byId.delete(id);
          } else {
            tombById.delete(id); // el libro revivió; la lápida ya no aplica
          }
        }

        return {
          books: Array.from(byId.values()),
          tombstones: Array.from(tombById.values()),
        };
      }),
      markBookPushed: (id) => set((s) => ({
        books: s.books.map((b) => (b.id === id ? { ...b, bookPushed: true } : b)),
      })),
    }),
    {
      name: 'folio-library',
      // OJO: NO subir `version` — sin una `migrate`, zustand persist DESCARTA el
      // estado persistido ante un cambio de versión (borraría la biblioteca del
      // usuario). El estado viejo simplemente no trae `tombstones`; el `merge`
      // por defecto de persist ({ ...initial, ...persisted }) mantiene el default
      // [] del estado inicial, así que la compatibilidad es automática.
    },
  ),
);
