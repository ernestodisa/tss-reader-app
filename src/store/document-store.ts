import { create } from 'zustand';
import { extractDocument } from '../agents/extractor';
import type { ExtractedDoc } from '../types';

interface DocumentStore {
  doc: ExtractedDoc | null;
  isLoading: boolean;
  error: string | null;
  loadDocument: (file: File) => Promise<boolean>;
  unloadDocument: () => void;
}

export const useDocumentStore = create<DocumentStore>((set) => ({
  doc: null,
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

  unloadDocument: () => {
    set({ doc: null, error: null, isLoading: false });
  },
}));