import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Bookmark, Note } from '../types';

const MAX_EXCERPT_LEN = 120;

function makeExcerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_EXCERPT_LEN
    ? `${trimmed.slice(0, MAX_EXCERPT_LEN)}…`
    : trimmed;
}

interface AnnotationsStore {
  bookmarks: Bookmark[];
  notes: Note[];

  addBookmark: (bookId: string, chapterIndex: number, paragraphIndex: number, paragraphText: string) => string;
  removeBookmark: (id: string) => void;
  /** true si ya existe un bookmark para esa posición exacta del libro. */
  hasBookmark: (bookId: string, chapterIndex: number, paragraphIndex: number) => boolean;
  /** Quita el bookmark que coincida con esa posición exacta (si existe). */
  removeBookmarkAt: (bookId: string, chapterIndex: number, paragraphIndex: number) => void;
  listBookmarks: (bookId: string) => Bookmark[];

  addNote: (bookId: string, chapterIndex: number, paragraphIndex: number, paragraphText: string, text: string) => string;
  removeNote: (id: string) => void;
  listNotes: (bookId: string) => Note[];
}

export const useAnnotationsStore = create<AnnotationsStore>()(
  persist(
    (set, get) => ({
      bookmarks: [],
      notes: [],

      addBookmark: (bookId, chapterIndex, paragraphIndex, paragraphText) => {
        const id = `bm-${bookId}-${chapterIndex}-${paragraphIndex}-${Date.now()}`;
        set((s) => ({
          bookmarks: [
            ...s.bookmarks,
            {
              id,
              bookId,
              chapterIndex,
              paragraphIndex,
              createdAt: Date.now(),
              excerpt: makeExcerpt(paragraphText),
            },
          ],
        }));
        return id;
      },

      removeBookmark: (id) => set((s) => ({
        bookmarks: s.bookmarks.filter((b) => b.id !== id),
      })),

      hasBookmark: (bookId, chapterIndex, paragraphIndex) =>
        get().bookmarks.some(
          (b) => b.bookId === bookId && b.chapterIndex === chapterIndex && b.paragraphIndex === paragraphIndex,
        ),

      removeBookmarkAt: (bookId, chapterIndex, paragraphIndex) => set((s) => ({
        bookmarks: s.bookmarks.filter(
          (b) => !(b.bookId === bookId && b.chapterIndex === chapterIndex && b.paragraphIndex === paragraphIndex),
        ),
      })),

      listBookmarks: (bookId) =>
        get()
          .bookmarks.filter((b) => b.bookId === bookId)
          .sort((a, b) => a.chapterIndex - b.chapterIndex || a.paragraphIndex - b.paragraphIndex),

      addNote: (bookId, chapterIndex, paragraphIndex, paragraphText, text) => {
        const id = `note-${bookId}-${chapterIndex}-${paragraphIndex}-${Date.now()}`;
        set((s) => ({
          notes: [
            ...s.notes,
            {
              id,
              bookId,
              chapterIndex,
              paragraphIndex,
              createdAt: Date.now(),
              excerpt: makeExcerpt(paragraphText),
              text,
            },
          ],
        }));
        return id;
      },

      removeNote: (id) => set((s) => ({
        notes: s.notes.filter((n) => n.id !== id),
      })),

      listNotes: (bookId) =>
        get()
          .notes.filter((n) => n.bookId === bookId)
          .sort((a, b) => a.chapterIndex - b.chapterIndex || a.paragraphIndex - b.paragraphIndex),
    }),
    { name: 'speechify-annotations' },
  ),
);
