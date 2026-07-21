import { useSyncExternalStore } from 'react';
import { subscribeSwUpdate, hasUpdate, applyUpdate } from '../lib/sw-update';

/**
 * Aviso flotante "hay versión nueva". Aparece cuando el service worker detecta
 * un deploy nuevo; un toque lo activa y recarga — adiós al ritual de cerrar y
 * abrir la app dos veces para recibir actualizaciones.
 */
export function UpdateToast() {
  const show = useSyncExternalStore(subscribeSwUpdate, hasUpdate);
  if (!show) return null;
  return (
    <button type="button" className="update-toast" onClick={applyUpdate}>
      ⬆ Versión nueva disponible — toca para actualizar
    </button>
  );
}
