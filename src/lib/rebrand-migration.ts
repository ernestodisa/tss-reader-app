// Migración de re-branding speechify-* → folio-*: renombra las llaves de
// persistencia SIN perder datos de usuarios existentes (beta F&F).
//
// IMPORTANTE: este módulo debe importarse ANTES que cualquier store en
// main.tsx — la parte de localStorage corre síncrona a nivel de módulo porque
// zustand/persist lee su llave al importarse el store.

import { createStore, entries, set as idbSet } from 'idb-keyval';
import type { UseStore } from 'idb-keyval';

// ── localStorage (zustand persist) ───────────────────────────────────────
const LS_RENAMES: Array<[string, string]> = [
  ['speechify-library', 'folio-library'],
  ['speechify-playback', 'folio-playback'],
  ['speechify-annotations', 'folio-annotations'],
];

for (const [oldKey, newKey] of LS_RENAMES) {
  try {
    const old = localStorage.getItem(oldKey);
    if (old !== null) {
      // Copia solo si la nueva no existe; la vieja se retira siempre (si la
      // nueva ya existe, la vieja es un remanente obsoleto).
      if (localStorage.getItem(newKey) === null) localStorage.setItem(newKey, old);
      localStorage.removeItem(oldKey);
    }
  } catch {
    // storage inaccesible (SSR/privacidad): los stores arrancan vacíos igual
  }
}

// ── IndexedDB (idb-keyval) ───────────────────────────────────────────────
// Copia todas las entradas del store viejo al nuevo UNA vez y borra la DB
// vieja. Se corre con await en main.tsx antes del render.
const IDB_FLAG = 'folio-idb-migrated';

async function copyIdbStore(
  oldDb: string,
  oldStoreName: string,
  target: UseStore,
): Promise<void> {
  // ¿Existe la DB vieja? indexedDB.databases() no está en todos los navegadores;
  // abrir sin upgrade y ver si tiene el object store es el camino portable.
  const oldStore = createStore(oldDb, oldStoreName);
  try {
    const all = await entries(oldStore);
    for (const [k, v] of all) {
      await idbSet(k as IDBValidKey, v, target);
    }
    indexedDB.deleteDatabase(oldDb);
  } catch {
    // DB vieja inexistente o ilegible: nada que migrar
  }
}

export async function migrateIdbToFolio(
  cacheStore: UseStore,
  docsStore: UseStore,
): Promise<void> {
  try {
    if (localStorage.getItem(IDB_FLAG)) return;
  } catch {
    return;
  }
  await copyIdbStore('speechify-cache', 'keyval', cacheStore);
  await copyIdbStore('speechify-library-docs', 'docs', docsStore);
  try {
    localStorage.setItem(IDB_FLAG, '1');
  } catch {
    // sin flag se re-intentará; copyIdbStore no pisa datos si la vieja ya no existe
  }
}
