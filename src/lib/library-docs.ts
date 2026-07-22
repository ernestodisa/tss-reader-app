import { createStore, get, set, del } from 'idb-keyval';
import type { ExtractedDoc } from '../types';
import { migrationReady } from './rebrand-migration';

// Exportado para la migración de re-branding (rebrand-migration.ts).
export const docsStore = createStore('folio-library-docs', 'docs');

export async function saveDoc(id: string, doc: ExtractedDoc): Promise<void> {
  await set(id, doc, docsStore);
}

export async function loadDoc(id: string): Promise<ExtractedDoc | undefined> {
  // M14: no leer hasta que la migración IDB haya copiado (o expirado su
  // timeout); si no, un libro pre-rebrand se vería "sin contenido". Post-migración
  // la promesa ya está resuelta → costo cero.
  await migrationReady;
  return get<ExtractedDoc>(id, docsStore);
}

export async function deleteDoc(id: string): Promise<void> {
  await del(id, docsStore);
}
