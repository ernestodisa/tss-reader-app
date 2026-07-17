import { create } from 'zustand';
import { extractDocument } from '../agents/extractor';
import type { ExtractedDoc } from '../types';

interface DocumentStore {
  doc: ExtractedDoc | null;
  /** id del libro abierto en la biblioteca (LibraryEntry.id). Lo consumen los
   *  marcadores/notas (annotations-store) y el guardado de progreso. Se setea al
   *  importar (ImportDropzone) o al abrir desde la biblioteca (Library). */
  currentBookId: string | null;
  /** Panel de marcadores/notas abierto (lo togglea el menú del AppHeader). */
  showAnnotations: boolean;
  isLoading: boolean;
  error: string | null;
  loadDocument: (file: File) => Promise<boolean>;
  setCurrentBookId: (id: string | null) => void;
  unloadDocument: () => void;
  toggleAnnotations: () => void;
  setShowAnnotations: (v: boolean) => void;
}

export const useDocumentStore = create<DocumentStore>((set) => ({
  doc: null,
  currentBookId: null,
  showAnnotations: false,
  isLoading: false,
  error: null,

  loadDocument: async (file: File) => {
    set({ isLoading: true, error: null });
    const result = await extractDocument(file);
    if (result.success) {
      set({ doc: result.data, isLoading: false });
      return true;
    } else {
      set({ isLoading: false, error: result.error.message });
      return false;
    }
  },

  setCurrentBookId: (id: string | null) => set({ currentBookId: id }),

  unloadDocument: () => {
    set({ doc: null, currentBookId: null, showAnnotations: false, error: null, isLoading: false });
  },

  toggleAnnotations: () => set((s) => ({ showAnnotations: !s.showAnnotations })),
  setShowAnnotations: (v: boolean) => set({ showAnnotations: v }),
}));