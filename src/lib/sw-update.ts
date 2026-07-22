/// <reference types="vite-plugin-pwa/client" />
// Detección de versión nueva de la PWA. Antes (registerType 'autoUpdate') el
// service worker nuevo quedaba "waiting" y tomaba control solo tras cerrar y
// abrir la app DOS veces — testers (y Ernesto) probaban builds viejos sin
// saberlo. Ahora el registro es 'prompt': cuando hay versión nueva se avisa a
// la UI (UpdateToast) y un toque activa el SW nuevo y recarga.

import { registerSW } from 'virtual:pwa-register';

type Listener = () => void;

let needRefresh = false;
const listeners = new Set<Listener>();
let updateFn: ((reloadPage?: boolean) => Promise<void>) | null = null;

export function initSwUpdate(): void {
  if (updateFn) return; // idempotente
  try {
    updateFn = registerSW({
      onNeedRefresh() {
        needRefresh = true;
        listeners.forEach((l) => l());
      },
    });
  } catch {
    // sin service worker (dev sin PWA, navegador raro): la app funciona igual
  }
}

// Contrato useSyncExternalStore para el componente del toast.
export function subscribeSwUpdate(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function hasUpdate(): boolean {
  return needRefresh;
}

/** ¿Hay un actualizador real disponible? Si es null, el botón "actualizar"
 *  sería un botón muerto (B9) y la UI debe dar feedback en su lugar. */
export function canApplyUpdate(): boolean {
  return updateFn !== null;
}

/**
 * Activa el SW nuevo y recarga la página con la versión fresca. Devuelve una
 * promesa: en el camino feliz la página se recarga y la promesa no llega a
 * resolver; si NO hay actualizador o la activación falla, rechaza para que la
 * UI muestre feedback en vez de quedarse muda (B9).
 *
 * Nota de posición (B9): la recarga preserva la posición a granularidad de
 * PÁRRAFO (el store zustand la persiste), pero la posición fina intra-párrafo
 * (palabra/offset del chunk) NO se persiste y se pierde. Guardarla exigiría
 * llegar al player agent (no es one-liner), así que se acepta el trade-off:
 * reanuda al inicio del párrafo en curso.
 */
export async function applyUpdate(): Promise<void> {
  if (!updateFn) throw new Error('No hay actualizador de service worker disponible');
  await updateFn(true);
}
