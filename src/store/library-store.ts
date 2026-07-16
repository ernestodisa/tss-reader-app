import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ExtractedDoc } from '../types';

interface LibraryEntry {
  id: string;
  title: string;
  author?: string;
  sourceType: 'pdf' | 'epub';
  totalPages?: number;
  totalCharacters: number;
  addedAt: number;
  lastReadChapter?: number;
  lastReadParagraph?: number;
}

interface LibraryStore {
  books: LibraryEntry[];
  addBook: (doc: ExtractedDoc) => string;
  removeBook: (id: string) => void;
  updateProgress: (id: string, chapter: number, paragraph: number) => void;
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
            },
          ],
        }));
        return id;
      },
      removeBook: (id: string) => set((s) => ({
        books: s.books.filter(b => b.id !== id),
      })),
      updateProgress: (id, chapter, paragraph) => set((s) => ({
        books: s.books.map(b =>
          b.id === id
            ? { ...b, lastReadChapter: chapter, lastReadParagraph: paragraph }
            : b
        ),
      })),
    }),
    { name: 'speechify-library' },
  ),
);