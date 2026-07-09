import { useLibraryStore } from '../store/library-store';

export function useLibrary() {
  const { books, addBook, removeBook, updateProgress } = useLibraryStore();
  return { books, addBook, removeBook, updateProgress };
}
