import { createStore, get, set, del } from 'idb-keyval';
import type { ExtractedDoc } from '../types';

const docsStore = createStore('speechify-library-docs', 'docs');

export async function saveDoc(id: string, doc: ExtractedDoc): Promise<void> {
  await set(id, doc, docsStore);
}

export async function loadDoc(id: string): Promise<ExtractedDoc | undefined> {
  return get<ExtractedDoc>(id, docsStore);
}

export async function deleteDoc(id: string): Promise<void> {
  await del(id, docsStore);
}
