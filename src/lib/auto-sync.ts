// Sincronización automática de biblioteca y progreso por IDENTIDAD (cuenta de
// Cloudflare Access). Es best-effort, pero YA NO silenciosa por diseño: hay cola
// con reintento+backoff, pull-antes-de-push ante conflicto (etag), y estado
// visible (useSyncStatus). La app funciona 100% offline aunque esto nunca conecte.
//
// Gotcha React 19 + Zustand: NO tocamos React aquí. Nos suscribimos al store con
// `store.subscribe` FUERA del árbol de componentes para no arriesgar el loop
// #185 (ver AnnotationsPanel). Este módulo se arranca una sola vez desde main.tsx.

import {
  useLibraryStore,
  syncedNow,
  setSyncClockOffset,
  type LibraryEntry,
} from '../store/library-store';
import { useSyncStatus } from '../store/sync-status-store';
import {
  pushProgressMe,
  pullProgressMe,
  pushBookMe,
  pullBookMe,
  type SyncPayload,
} from './sync-client';
import { loadDoc, saveDoc } from './library-docs';

const PUSH_DEBOUNCE_MS = 20_000; // ventana de reposo tras el último cambio
const PUSH_MAX_WAIT_MS = 60_000; // A10: aunque los cambios no paren, pushea al minuto
const BACKOFF_MIN_MS = 5_000; // A10: primer reintento a 5s…
const BACKOFF_MAX_MS = 5 * 60_000; // …duplicando hasta un tope de 5min
const MAX_SYNC_BYTES = 64 * 1024; // debe coincidir con el cap del worker

let started = false;

// Handles para poder desregistrar TODO en stopAutoSync (B5).
let unsubscribe: (() => void) | null = null;
let onVisibility: (() => void) | null = null;
let onPageHide: (() => void) | null = null;
let onOnline: (() => void) | null = null;

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pushing = false;
let dirty = false; // hay cambios sin subir
let firstDirtyAt: number | null = null; // ancla del maxWait
let backoffMs = BACKOFF_MIN_MS;
let lastEtag: string | null = null; // última versión conocida del snapshot en la nube

// Contador de "aplicando remoto": mientras > 0, el suscriptor del store NO agenda
// push. Evita que mergeBooks/markBookPushed del pull (o de un merge por conflicto)
// disparen un push derivado (B5). Es un contador porque los set() de zustand son
// síncronos y pueden anidarse.
let applyingRemoteDepth = 0;

// ids conocidos para detectar altas de libros nuevos (sube su contenido una vez).
let knownIds = new Set<string>();

// ids cuyo contenido ya intentamos subir en esta sesión (evita reintentos en
// ráfaga dentro del mismo ciclo; la marca durable vive en entry.bookPushed).
const bookPushInFlight = new Set<string>();

function clearDebounce(): void {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
}
function clearRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/** Ejecuta una mutación remota del store sin que el suscriptor agende push. */
function applyRemote(fn: () => void): void {
  applyingRemoteDepth++;
  try {
    fn();
  } finally {
    applyingRemoteDepth--;
  }
}

function encodedSize(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Construye el snapshot a subir. A9: NUNCA incluye `coverDataUrl` (portadas de
 *  8–25KB c/u que revientan el cap de 64KB). Incluye tombstones (M9) y estampa
 *  syncedAt con el reloj sincronizado (M8). */
function buildSnapshot(): { payload: SyncPayload; json: string } {
  const st = useLibraryStore.getState();
  const books = st.books.map(({ coverDataUrl: _cover, ...rest }) => rest as LibraryEntry);
  const payload: SyncPayload = { books, tombstones: st.tombstones, syncedAt: syncedNow() };
  return { payload, json: JSON.stringify(payload) };
}

/** Calibra el offset del reloj con el serverNow del worker (M8). Best-effort:
 *  no compensa la latencia fina, sí relojes desfasados por minutos. */
function applyServerNow(serverNow: number | null): void {
  if (serverNow != null) setSyncClockOffset(serverNow - Date.now());
}

/** Marca que hay cambios pendientes y agenda el push con debounce + maxWait. */
function markDirty(): void {
  dirty = true;
  if (firstDirtyAt == null) firstDirtyAt = Date.now();
  useSyncStatus.getState().markPending();
  schedule();
}

/** Debounce de PUSH_DEBOUNCE_MS con tope duro de PUSH_MAX_WAIT_MS desde el primer
 *  cambio: en lectura continua (un cambio de párrafo cada pocos segundos) el push
 *  igual se dispara al minuto en vez de posponerse indefinidamente. */
function schedule(): void {
  if (pushing) return; // el finally del push en vuelo re-agenda al drenar
  clearDebounce();
  const now = Date.now();
  const capByMaxWait =
    firstDirtyAt != null ? firstDirtyAt + PUSH_MAX_WAIT_MS - now : PUSH_DEBOUNCE_MS;
  const delay = Math.max(0, Math.min(PUSH_DEBOUNCE_MS, capByMaxWait));
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushProgressNow();
  }, delay);
}

/** Reintento con backoff exponencial mientras quede dirty. */
function scheduleRetry(): void {
  clearRetry();
  const delay = backoffMs;
  backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void pushProgressNow();
  }, delay);
}

/** Empuja el snapshot. Un solo push a la vez; si llega otro flush con push en
 *  vuelo, marca dirty y el finally drena. Ante conflicto de etag hace
 *  pull+merge+re-push. */
async function pushProgressNow(opts: { keepalive?: boolean } = {}): Promise<void> {
  if (pushing) {
    dirty = true; // el push en vuelo drenará en su finally
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    dirty = true;
    useSyncStatus.getState().markPending();
    return; // el listener 'online' re-disparará
  }
  pushing = true;
  clearDebounce();
  clearRetry();
  // Consumimos el estado dirty ANTES del await; si algo cambia durante el push,
  // se re-marca y drenamos en el finally.
  dirty = false;
  firstDirtyAt = null;
  try {
    const outcome = await doPush(opts.keepalive === true);
    if (outcome === 'ok') {
      backoffMs = BACKOFF_MIN_MS;
      useSyncStatus.getState().markOk();
    } else if (outcome === 'fail') {
      dirty = true; // doPush ya dejó el mensaje de error en el status
      scheduleRetry();
    }
    // outcome === 'oversize' → no reintentar (el mismo snapshot gigante no
    // mejora); dirty ya está en false y el error queda visible.
  } finally {
    pushing = false;
    if (dirty && !retryTimer && !pushTimer) schedule(); // drena cambios llegados en vuelo
  }
}

type PushOutcome = 'ok' | 'fail' | 'oversize';

/** Un intento completo (con hasta 2 reintentos por conflicto de etag). */
async function doPush(keepalive: boolean): Promise<PushOutcome> {
  const status = useSyncStatus.getState();
  for (let attempt = 0; attempt <= 2; attempt++) {
    const { payload, json } = buildSnapshot();
    if (encodedSize(json) > MAX_SYNC_BYTES) {
      const msg = `El snapshot supera ${MAX_SYNC_BYTES / 1024}KB aun sin portadas; no se subió.`;
      console.warn('[auto-sync] ' + msg, `(${encodedSize(json)} bytes)`);
      status.markError(msg);
      return 'oversize';
    }
    const res = await pushProgressMe(payload, { ifMatch: lastEtag ?? undefined, keepalive });
    if (res.success) {
      if (res.data.etag) lastEtag = res.data.etag;
      applyServerNow(res.data.serverNow);
      return 'ok';
    }
    if (res.error.code !== 'conflict') {
      status.markError(res.error.message);
      return 'fail';
    }
    // A11: otro dispositivo/tab escribió en medio → pull, merge y reintenta con
    // el etag fresco. Convierte el lost-update en merge.
    const pull = await pullProgressMe();
    if (!pull.success) {
      status.markError(pull.error.message);
      return 'fail';
    }
    applyRemote(() =>
      useLibraryStore.getState().mergeBooks(pull.data.books, pull.data.tombstones),
    );
    lastEtag = pull.data.etag;
    applyServerNow(pull.data.serverNow);
  }
  status.markError('Conflicto de sincronización persistente; se reintentará.');
  return 'fail';
}

/** Sube el contenido completo de un libro UNA sola vez y lo marca. */
async function pushBookContentOnce(entry: LibraryEntry): Promise<void> {
  if (entry.bookPushed || bookPushInFlight.has(entry.id)) return;
  bookPushInFlight.add(entry.id);
  try {
    const doc = await loadDoc(entry.id);
    if (!doc) return; // contenido aún no persistido; se reintenta en el próximo cambio
    const result = await pushBookMe(entry.id, doc);
    if (result.success) {
      // applyRemote: marcar bookPushed NO debe disparar un push de progreso (B5).
      applyRemote(() => useLibraryStore.getState().markBookPushed(entry.id));
    }
  } catch {
    // silencioso: el contenido se reintenta en el próximo arranque/cambio
  } finally {
    bookPushInFlight.delete(entry.id);
  }
}

/** Descarga el ExtractedDoc de los libros que existen en la biblioteca pero no
 *  tienen contenido local (típicamente entradas recién bajadas de la nube). */
async function downloadMissingDocs(): Promise<void> {
  const books = useLibraryStore.getState().books;
  for (const b of books) {
    try {
      const local = await loadDoc(b.id);
      if (local) continue;
      const result = await pullBookMe(b.id);
      if (result.success) {
        await saveDoc(b.id, result.data);
        // Ya está en la nube: no reintentar subirlo (sin disparar push, B5).
        if (!b.bookPushed) applyRemote(() => useLibraryStore.getState().markBookPushed(b.id));
      }
    } catch {
      // silencioso; se reintenta en el próximo arranque
    }
  }
}

/** Pull inicial: fusiona la nube con lo local (merge por-campo + tombstones sin
 *  pisar progreso local más nuevo) y baja los contenidos que falten. */
async function initialPull(): Promise<void> {
  const result = await pullProgressMe();
  if (!result.success) return; // sin sesión o sin red: seguimos offline
  lastEtag = result.data.etag;
  applyServerNow(result.data.serverNow);
  applyRemote(() =>
    useLibraryStore.getState().mergeBooks(result.data.books, result.data.tombstones),
  );
  await downloadMissingDocs();
  // Los libros locales que aún no están en la nube (importados antes de que
  // existiera el sync por identidad, o cuyo push falló) se suben aquí — el
  // suscriptor del store solo detecta ids NUEVOS, así que sin este barrido el
  // contenido pre-existente jamás subiría y otro dispositivo vería la entrada
  // sin poder abrirla.
  for (const b of useLibraryStore.getState().books) {
    if (!b.bookPushed) await pushBookContentOnce(b);
  }
  // Publica el snapshot (ya fusionado) para que la nube quede al día.
  void pushProgressNow();
}

/** Último intento al ocultar/cerrar la pestaña (A8). Usa keepalive para que el
 *  navegador no lo mate a media petición. Se dispara AUNQUE haya un push en
 *  vuelo (es la última oportunidad); puede duplicar un PUT, pero el PUT es
 *  idempotente (mismo objeto R2). No espera respuesta. B5: no-op si no hay nada
 *  pendiente, para no emitir PUTs idénticos en cada cambio de pestaña. */
function lastChancePush(): void {
  if (!dirty && !pushTimer && !retryTimer) return;
  const { payload, json } = buildSnapshot();
  if (encodedSize(json) > MAX_SYNC_BYTES) return; // no cabe en keepalive de todos modos
  void pushProgressMe(payload, { ifMatch: lastEtag ?? undefined, keepalive: true });
}

/** Arranca el auto-sync una sola vez. Idempotente. */
export function initAutoSync(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  knownIds = new Set(useLibraryStore.getState().books.map((b) => b.id));

  // Pull al arrancar (no bloquea el render; corre en segundo plano).
  void initialPull();

  // Suscripción cruda al store (fuera de React).
  unsubscribe = useLibraryStore.subscribe((state) => {
    const currentIds = new Set(state.books.map((b) => b.id));
    // No re-disparar por mutaciones remotas (merge del pull, markBookPushed).
    if (applyingRemoteDepth > 0) {
      knownIds = currentIds;
      return;
    }
    for (const b of state.books) {
      if (!knownIds.has(b.id) && !b.bookPushed) void pushBookContentOnce(b);
    }
    knownIds = currentIds;
    markDirty();
  });

  // Push inmediato al ocultar la pestaña. Crítico en PWA de iOS: no hay evento
  // de cierre confiable, así que aprovechamos visibilitychange → hidden.
  onVisibility = () => {
    if (document.visibilityState === 'hidden') lastChancePush();
  };
  onPageHide = () => lastChancePush();
  // Al recuperar red, drenar de inmediato lo pendiente (A10).
  onOnline = () => {
    if (dirty) {
      clearRetry();
      void pushProgressNow();
    }
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);
}

/** Desmonta el auto-sync: desregistra suscripción, listeners y timers. Hoy solo
 *  se usa en tests/HMR, pero deja el módulo sin fugas (B5). */
export function stopAutoSync(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (onVisibility) {
    document.removeEventListener('visibilitychange', onVisibility);
    onVisibility = null;
  }
  if (onPageHide) {
    window.removeEventListener('pagehide', onPageHide);
    onPageHide = null;
  }
  if (onOnline) {
    window.removeEventListener('online', onOnline);
    onOnline = null;
  }
  clearDebounce();
  clearRetry();
  started = false;
}
