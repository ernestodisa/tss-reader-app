import { useDocumentStore } from '../store/document-store';

export function useDocument() {
  const { doc, isLoading, error, loadDocument, unloadDocument } = useDocumentStore();
  return { doc, isLoading, error, loadDocument, unloadDocument };
}
