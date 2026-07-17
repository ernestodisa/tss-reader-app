// Sincronización automática de biblioteca y progreso por IDENTIDAD (cuenta de
// Cloudflare Access). Todo es best-effort y silencioso: si no hay sesión (401)
// o falla la red, se degrada sin ruido y se reintenta en el siguiente disparo.
// La app funciona 100% offline aunque esto nunca conecte.
//
// Gotcha React 19 + Zustand: NO tocamos React aquí. Nos suscribimos al store
// con `store.subscribe` FUERA del árbol de componentes para no arriesgar el
// loop #185 (ver AnnotationsPanel). Este módulo se arranca una sola vez desde
// main.tsx.

import { useLibraryStore, type LibraryEntry } from '../store/library-store';
import { pushProgressMe, pullProgressMe, pushBookMe, pullBookMe } from './sync-client';
import { loadDoc, saveDoc } from './library-docs';

const PUSH_DEBOUNCE_MS = 20_000;

let started = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pushing = false;
// ids cuyo contenido ya intentamos subir en esta sesión (evita reintentos en
// ráfaga dentro del mismo ciclo; la marca durable vive en entry.bookPushed).
const bookPushInFlight = new Set<string>();

/** Empuja el snapshot de progreso/biblioteca. Silencioso ante 401/red. */
async function pushProgressNow(): Promise<void> {
  if (pushing) return;
  pushing = true;
  try {
    const books = useLibraryStore.getState().books;
    await pushProgressMe({ books, syncedAt: Date.now() });
    // El resultado se ignora a propósito: degradación silenciosa.
  } catch {
    // nunca propagar
  } finally {
    pushing = false;
  }
}

function schedulePush(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushProgressNow();
  }, PUSH_DEBOUNCE_MS);
}

function flushPush(): void {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  void pushProgressNow();
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
      useLibraryStore.getState().markBookPushed(entry.id);
    }
  } catch {
    // silencioso
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
        // Ya está en la nube: no reintentar subirlo.
        if (!b.bookPushed) useLibraryStore.getState().markBookPushed(b.id);
      }
    } catch {
      // silencioso; se reintenta en el próximo arranque
    }
  }
}

/** Pull inicial: fusiona la nube con lo local (last-write-wins por libro vía
 *  mergeBooks) sin pisar progreso local más nuevo, y baja los contenidos que
 *  falten. */
async function initialPull(): Promise<void> {
  const result = await pullProgressMe();
  if (!result.success) return; // sin sesión o sin red: seguimos offline
  useLibraryStore.getState().mergeBooks(result.data.books);
  await downloadMissingDocs();
  // Los libros locales que aún no están en la nube (importados antes de que
  // existiera el sync por identidad, o cuyo push falló) se suben aquí — el
  // suscriptor del store solo detecta ids NUEVOS, así que sin este barrido el
  // contenido pre-existente jamás subiría y otro dispositivo vería la entrada
  // sin poder abrirla.
  for (const b of useLibraryStore.getState().books) {
    if (!b.bookPushed) await pushBookContentOnce(b);
  }
  // Y publica el snapshot de progreso para que la nube quede al día.
  void pushProgressNow();
}

/** Arranca el auto-sync una sola vez. Idempotente. */
export function initAutoSync(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  // ids conocidos para detectar altas de libros nuevos.
  let knownIds = new Set(useLibraryStore.getState().books.map((b) => b.id));

  // Pull al arrancar (no bloquea el render; corre en segundo plano).
  void initialPull();

  // Suscripción cruda al store (fuera de React). Cualquier cambio de progreso o
  // de la biblioteca dispara: (a) subir contenido de libros nuevos una vez,
  // (b) push de progreso con debounce.
  useLibraryStore.subscribe((state) => {
    const currentIds = new Set(state.books.map((b) => b.id));
    for (const b of state.books) {
      if (!knownIds.has(b.id) && !b.bookPushed) {
        void pushBookContentOnce(b);
      }
    }
    knownIds = currentIds;
    schedulePush();
  });

  // Push inmediato al ocultar la pestaña. Crítico en PWA de iOS: no hay evento
  // de cierre confiable, así que aprovechamos visibilitychange → hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPush();
  });
  // pagehide como respaldo (Safari iOS al descartar la pestaña).
  window.addEventListener('pagehide', () => flushPush());
}
