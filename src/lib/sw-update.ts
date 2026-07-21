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

/** Activa el SW nuevo y recarga la página con la versión fresca. */
export function applyUpdate(): void {
  void updateFn?.(true);
}
