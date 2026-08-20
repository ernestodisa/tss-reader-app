/// <reference types="vite-plugin-pwa/client" />
// Detección de versión nueva de la PWA. Antes (registerType 'autoUpdate') el
// service worker nuevo quedaba "waiting" y tomaba control solo tras cerrar y
// abrir la app DOS veces — testers (y Ernesto) probaban builds viejos sin
// saberlo. Ahora el registro es 'prompt': cuando hay versión nueva se avisa a
// la UI (UpdateToast) y un toque activa el SW nuevo y recarga.

import { registerSW } from 'virtual:pwa-register';

type Listener = () => void;

let needRefresh = false;
let sessionExpired = false;
const listeners = new Set<Listener>();
let updateFn: ((reloadPage?: boolean) => Promise<void>) | null = null;

// Chequeo ACTIVO de updates (auditoría 2026-08-20): en modo 'prompt' sin esto,
// el update check solo corría en el registro inicial — una PWA instalada podía
// quedarse en una versión vieja indefinidamente sin mostrar nunca el toast.
const SW_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h

export function initSwUpdate(): void {
  if (updateFn) return; // idempotente
  try {
    updateFn = registerSW({
      onNeedRefresh() {
        needRefresh = true;
        listeners.forEach((l) => l());
      },
      onRegisteredSW(swUrl, registration) {
        if (!registration) return;
        const check = async () => {
          if (!navigator.onLine) return;
          // Fetch explícito ANTES de registration.update(): update() no expone
          // la respuesta HTTP, y detrás de Cloudflare Access un sw.js con la
          // sesión OTP expirada responde 302 → login, con lo que el update
          // check fallaba EN SILENCIO para siempre. redirect:'manual' convierte
          // ese 302 en un `opaqueredirect` observable → se avisa a la UI
          // ("sesión expirada") en vez de fallar mudo.
          let resp: Response | null = null;
          try {
            resp = await fetch(swUrl, { cache: 'no-store', redirect: 'manual' });
          } catch {
            return; // sin red / fallo transitorio: reintenta el próximo ciclo
          }
          if (resp.status === 200) {
            if (sessionExpired) {
              sessionExpired = false; // la sesión volvió: retira el aviso
              listeners.forEach((l) => l());
            }
            await registration.update().catch(() => {
              /* update check fallido: reintenta el próximo ciclo */
            });
          } else if (resp.type === 'opaqueredirect' || (resp.status >= 300 && resp.status < 400)) {
            if (!sessionExpired) {
              sessionExpired = true;
              listeners.forEach((l) => l());
            }
          }
        };
        void check(); // al arrancar: detecta desde ya una sesión expirada
        setInterval(() => void check(), SW_CHECK_INTERVAL_MS);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void check();
        });
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

/** La sesión de Cloudflare Access expiró (el chequeo de sw.js recibe 302 al
 *  login): la PWA no puede ni actualizar ni hablar con la API hasta re-entrar.
 *  La UI debe ofrecer recargar — la navegación pasa por el login de Access. */
export function sessionNeedsLogin(): boolean {
  return sessionExpired;
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
