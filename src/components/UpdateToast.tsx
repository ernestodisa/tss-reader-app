import { useState } from 'react';
import { useSyncExternalStore } from 'react';
import { subscribeSwUpdate, hasUpdate, applyUpdate, canApplyUpdate } from '../lib/sw-update';
import { IconClose, IconUp } from './icons';

/**
 * Aviso flotante "hay versión nueva". Aparece cuando el service worker detecta
 * un deploy nuevo; un toque lo activa y recarga — adiós al ritual de cerrar y
 * abrir la app dos veces para recibir actualizaciones.
 *
 * B9: además del botón de actualizar, tiene botón de cerrar (descarta el toast
 * SOLO esta sesión — el descarte es estado local, no se persiste: al recargar o
 * reabrir la app, el próximo registro del SW vuelve a mostrarlo). Y si no hay
 * actualizador o la activación falla, muestra feedback en vez de un botón muerto.
 */
export function UpdateToast() {
  const show = useSyncExternalStore(subscribeSwUpdate, hasUpdate);
  const [dismissed, setDismissed] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!show || dismissed) return null;

  const handleApply = async () => {
    // Sin actualizador real → botón muerto: da feedback en lugar de no hacer nada.
    if (!canApplyUpdate()) {
      setFailed(true);
      return;
    }
    try {
      // Camino feliz: activa el SW nuevo y recarga (la promesa no llega a
      // resolver porque la página se recarga). Si falla, cae al catch.
      await applyUpdate();
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="update-toast" role="status">
      <button
        type="button"
        className="update-toast-action"
        onClick={handleApply}
        disabled={failed}
      >
        <IconUp />{' '}
        {failed
          ? 'No se pudo actualizar — cierra y reabre la app'
          : 'Versión nueva disponible — toca para actualizar'}
      </button>
      <button
        type="button"
        className="update-toast-close"
        onClick={() => setDismissed(true)}
        aria-label="Descartar aviso de actualización"
        title="Descartar (reaparece al reabrir la app)"
      >
        <IconClose />
      </button>
    </div>
  );
}
