// Migración de re-branding speechify-* → folio-*: renombra las llaves de
// persistencia SIN perder datos de usuarios existentes (beta F&F).
//
// IMPORTANTE: este módulo debe importarse ANTES que cualquier store en
// main.tsx — la parte de localStorage corre síncrona a nivel de módulo porque
// zustand/persist lee su llave al importarse el store.
//
// La parte de IndexedDB (A14 + M14) es asíncrona y NO bloquea el primer render:
// main.tsx lanza `migrateIdbToFolio` sin await y los puntos de lectura inicial
// de IDB esperan `migrationReady` antes de leer (ver más abajo).

import { createStore, get as idbGet, set as idbSet, keys as idbKeys } from 'idb-keyval';
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

// ── Coordinación con el primer render (M14) ──────────────────────────────
// `migrationReady` se resuelve cuando la migración IDB termina, O cuando expira
// un timeout de seguridad. Los DOS puntos de lectura inicial de IDB (carga del
// doc de un libro al abrirlo → library-docs.loadDoc; cache TTS →
// IndexedDBCache.get) hacen `await migrationReady` antes de leer, para no ver un
// libro "sin contenido" mientras la copia está en curso. En el caso normal
// (post-migración o usuario nuevo) la promesa ya está resuelta → costo cero.
//
// El timeout evita que un `indexedDB.open` colgado (bug conocido de Safari) deje
// la app muerta: si expira, las lecturas continúan, el flag NO se marca y la
// migración se reintenta el próximo arranque.
const MIGRATION_TIMEOUT_MS = 15_000;
let migrationSettled = false;
let markMigrationDone!: () => void;
let migrationTimer: ReturnType<typeof setTimeout>;

const migrationDone = new Promise<void>((resolve) => {
  markMigrationDone = resolve;
});

export const migrationReady: Promise<void> = Promise.race([
  migrationDone,
  new Promise<void>((resolve) => {
    migrationTimer = setTimeout(() => {
      if (!migrationSettled) {
        console.warn(
          `[rebrand-migration] la migración IDB excedió ${MIGRATION_TIMEOUT_MS}ms ` +
            '(posible indexedDB.open colgado en Safari); la app continúa y se reintentará al próximo arranque',
        );
      }
      resolve();
    }, MIGRATION_TIMEOUT_MS);
  }),
]);

// ── IndexedDB (idb-keyval) ───────────────────────────────────────────────
const IDB_FLAG = 'folio-idb-migrated';
const COPY_BATCH = 20; // llaves por lote; yield entre lotes para no bloquear el hilo

// ¿Existe la DB vieja (con su object store) SIN crearla por accidente?
//
// Truco: `indexedDB.open(name)` crea la DB si no existía y dispara
// `onupgradeneeded` con `oldVersion === 0`. Al detectarlo, abortamos la
// transacción de versión → rollback: la DB NO llega a crearse. Así distinguimos
// "no existía" de "existe de verdad" sin dejar una DB fantasma.
type OldDbState = 'absent' | 'present';

function checkOldDb(name: string, storeName: string): Promise<OldDbState> {
  return new Promise<OldDbState>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(name);
    } catch {
      resolve('absent');
      return;
    }
    let createdByUs = false;
    req.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        // La DB no existía y la acabamos de crear sin querer: abortamos para
        // hacer rollback y no dejar una DB fantasma.
        createdByUs = true;
        try {
          req.transaction?.abort();
        } catch {
          /* algunos navegadores ya la habrán marcado para abort */
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const hasStore = db.objectStoreNames.contains(storeName);
      db.close();
      // Existe pero sin el object store esperado → nada que migrar (éxito trivial).
      resolve(hasStore ? 'present' : 'absent');
    };
    req.onerror = () => {
      // Si el error viene de NUESTRO abort, la DB no existía → 'absent' (éxito
      // trivial). Cualquier otro error → la tratamos como 'present' para que la
      // copia lo intente y, si falla, devuelva 'failed' (no marca flag → reintento).
      resolve(createdByUs ? 'absent' : 'present');
    };
    req.onblocked = () => resolve('present'); // existe pero bloqueada por otra pestaña
  });
}

// Copia todas las entradas del store viejo al nuevo y borra la DB vieja SOLO
// tras una copia completa OK. Devuelve un resultado explícito:
//   'ok'     → copia completa (o nada que migrar): se puede marcar el flag.
//   'failed' → falló a media copia: NO marcar el flag, reintentar al próximo
//              arranque. La copia es idempotente (salta llaves ya en destino).
async function copyIdbStore(
  oldDb: string,
  oldStoreName: string,
  target: UseStore,
): Promise<'ok' | 'failed'> {
  const state = await checkOldDb(oldDb, oldStoreName);
  if (state === 'absent') return 'ok'; // éxito trivial: nada que migrar

  const oldStore = createStore(oldDb, oldStoreName);
  try {
    const srcKeys = await idbKeys(oldStore);
    if (srcKeys.length === 0) {
      indexedDB.deleteDatabase(oldDb);
      return 'ok';
    }
    // Idempotencia: la migración pudo correr antes y fallar a medias. Leemos las
    // llaves ya presentes en el destino UNA vez y saltamos esas para no pisar
    // datos nuevos (set condicional).
    const existing = new Set<string>((await idbKeys(target)).map(String));

    // M14: copiar por lotes con `get`/`set` (no `entries()`, que materializa
    // TODOS los ArrayBuffers de audio en memoria de golpe → pantalla blanca y
    // riesgo de jetsam en iOS). Yield entre lotes para no bloquear el hilo.
    for (let i = 0; i < srcKeys.length; i += COPY_BATCH) {
      const batch = srcKeys.slice(i, i + COPY_BATCH);
      for (const k of batch) {
        if (existing.has(String(k))) continue;
        const v = await idbGet(k, oldStore);
        if (v !== undefined) await idbSet(k, v, target);
      }
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    // Copia completa OK → recién ahora borramos la DB vieja.
    indexedDB.deleteDatabase(oldDb);
    return 'ok';
  } catch (e) {
    // QuotaExceeded, cierre a media copia, DB ilegible: NO marcar migrado.
    console.warn('[rebrand-migration] copia IDB falló a media; se reintentará al próximo arranque', e);
    return 'failed';
  }
}

export async function migrateIdbToFolio(
  cacheStore: UseStore,
  docsStore: UseStore,
): Promise<void> {
  try {
    try {
      if (localStorage.getItem(IDB_FLAG)) return;
    } catch {
      return; // storage inaccesible: no podemos ni marcar; los stores arrancan vacíos
    }

    const r1 = await copyIdbStore('speechify-cache', 'keyval', cacheStore);
    const r2 = await copyIdbStore('speechify-library-docs', 'docs', docsStore);

    // A14: marcar "migrado" SOLO si AMBAS copias terminaron bien. Si alguna
    // falló a medias, dejamos el flag sin poner → se reintenta el próximo
    // arranque (la copia es idempotente y no pisa lo ya escrito).
    if (r1 === 'ok' && r2 === 'ok') {
      try {
        localStorage.setItem(IDB_FLAG, '1');
      } catch {
        // sin flag se reintentará; inofensivo porque la copia es idempotente
      }
    }
  } finally {
    // Libera a los lectores de IDB que esperan `migrationReady`, pase lo que pase.
    migrationSettled = true;
    clearTimeout(migrationTimer);
    markMigrationDone();
  }
}
