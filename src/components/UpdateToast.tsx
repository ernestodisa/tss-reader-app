import { useState } from 'react';
import { useSyncExternalStore } from 'react';
import {
  subscribeSwUpdate,
  hasUpdate,
  applyUpdate,
  canApplyUpdate,
  sessionNeedsLogin,
} from '../lib/sw-update';
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
  const expired = useSyncExternalStore(subscribeSwUpdate, sessionNeedsLogin);
  const [dismissed, setDismissed] = useState(false);
  const [expiredDismissed, setExpiredDismissed] = useState(false);
  const [failed, setFailed] = useState(false);

  // Sesión de Access expirada (detectada por el chequeo de sw.js): sin
  // re-entrar no llegan ni updates ni API. Recargar navega → Access intercepta
  // → login → de vuelta con sesión fresca. El aviso de versión nueva tiene
  // prioridad si ambos aplican (aplicar el update también recarga).
  if ((!show || dismissed) && expired && !expiredDismissed) {
    return (
      <div className="update-toast" role="status">
        <button
          type="button"
          className="update-toast-action"
          onClick={() => window.location.reload()}
        >
          <IconUp /> Tu sesión expiró — toca para volver a entrar
        </button>
        <button
          type="button"
          className="update-toast-close"
          onClick={() => setExpiredDismissed(true)}
          aria-label="Descartar aviso de sesión expirada"
          title="Descartar (reaparece al reabrir la app)"
        >
          <IconClose />
        </button>
      </div>
    );
  }

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
