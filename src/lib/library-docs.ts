import { createStore, get, set, del } from 'idb-keyval';
import type { ExtractedDoc } from '../types';

// Exportado para la migración de re-branding (rebrand-migration.ts).
export const docsStore = createStore('folio-library-docs', 'docs');

export async function saveDoc(id: string, doc: ExtractedDoc): Promise<void> {
  await set(id, doc, docsStore);
}

export async function loadDoc(id: string): Promise<ExtractedDoc | undefined> {
  return get<ExtractedDoc>(id, docsStore);
}

export async function deleteDoc(id: string): Promise<void> {
  await del(id, docsStore);
}
