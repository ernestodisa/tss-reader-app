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
  /** Portada reducida (dataURL JPEG) copiada de ExtractedDoc.coverDataUrl al importar. */
  coverDataUrl?: string;
  /** Marca de tiempo del último cambio de progreso; usado por sync-client para
   *  resolver conflictos entre dispositivos (gana el más reciente). */
  updatedAt?: number;
}

interface LibraryStore {
  books: LibraryEntry[];
  addBook: (doc: ExtractedDoc) => string;
  removeBook: (id: string) => void;
  updateProgress: (id: string, chapter: number, paragraph: number, percent?: number) => void;
  /** Reemplaza el arreglo completo de libros (usado al bajar progreso vía sync). */
  mergeBooks: (incoming: LibraryEntry[]) => void;
}

export const useLibraryStore = create<LibraryStore>()(
  persist(
    (set) => ({
      books: [],
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
              addedAt: Date.now(),
              coverDataUrl: doc.coverDataUrl,
            },
          ],
        }));
        return id;
      },
      removeBook: (id: string) => set((s) => ({
        books: s.books.filter(b => b.id !== id),
      })),
      updateProgress: (id, chapter, paragraph, percent) => set((s) => ({
        books: s.books.map(b =>
          b.id === id
            ? {
                ...b,
                lastReadChapter: chapter,
                lastReadParagraph: paragraph,
                ...(percent != null ? { lastReadPercent: percent } : {}),
                updatedAt: Date.now(),
              }
            : b
        ),
      })),
      // Merge conservando, por id, la entrada con updatedAt/addedAt más reciente.
      // Libros que solo existen de un lado se conservan tal cual.
      mergeBooks: (incoming) => set((s) => {
        const byId = new Map(s.books.map((b) => [b.id, b]));
        for (const inBook of incoming) {
          const existing = byId.get(inBook.id);
          if (!existing) {
            byId.set(inBook.id, inBook);
            continue;
          }
          const existingTs = existing.updatedAt ?? existing.addedAt;
          const incomingTs = inBook.updatedAt ?? inBook.addedAt;
          byId.set(inBook.id, incomingTs > existingTs ? inBook : existing);
        }
        return { books: Array.from(byId.values()) };
      }),
    }),
    { name: 'speechify-library' },
  ),
);