import type { MediaSessionConfig } from '../types';

// ── Media Session API ──────────────────────────────────────────────────────
//
// Habilita los controles del SO en la pantalla de bloqueo / centro de control
// (play/pause, anterior/siguiente) y muestra metadata (título, autor, capítulo).
// Todo va detrás de un guard de existencia: navigator.mediaSession solo existe
// en navegadores que lo soportan y algunos action handlers lanzan si el navegador
// no reconoce la acción, por eso cada setActionHandler va en su propio try/catch.

/**
 * Registra metadata + action handlers + playbackState en navigator.mediaSession.
 * Es idempotente: llamarla en cada cambio de párrafo/estado simplemente
 * sobreescribe la configuración anterior. No-op si la API no existe.
 */
export function setupMediaSession(config: MediaSessionConfig): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return;
  }
  const ms = navigator.mediaSession;

  // Metadata visible en la pantalla de bloqueo.
  if (typeof MediaMetadata !== 'undefined') {
    ms.metadata = new MediaMetadata({
      title: config.title,
      artist: config.author ?? '',
      album: config.chapter ?? '',
    });
  }

  const { handlers } = config;

  // Mapeo de acciones del SO → handlers de la app.
  // play/pause: el handler `play` debe reanudar el AudioContext (resume) para
  // que el audio en background vuelva tras un bloqueo de pantalla.
  const bindings: Array<[MediaSessionAction, MediaSessionActionHandler | null]> = [
    ['play', () => handlers.play()],
    ['pause', () => handlers.pause()],
    ['previoustrack', () => handlers.prev()],
    ['nexttrack', () => handlers.next()],
    // Salto por capítulo mapeado a seekbackward/seekforward (los controles de
    // "retroceder/avanzar" del SO). Solo se registran si se proveen handlers.
    ['seekbackward', handlers.prevChapter ? () => handlers.prevChapter!() : null],
    ['seekforward', handlers.nextChapter ? () => handlers.nextChapter!() : null],
  ];

  for (const [action, handler] of bindings) {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      // El navegador no soporta esta acción — se ignora sin romper el resto.
    }
  }

  // Estado reflejado en la UI del SO (icono play vs pause).
  try {
    ms.playbackState = config.playbackState ?? 'playing';
  } catch {
    /* playbackState no soportado */
  }
}

/**
 * Publica la posición/duración del audio actual en la Media Session. En
 * Android, una sesión con positionState "completa" tiene mejor promoción a la
 * notificación de medios — y esa notificación es lo que exenta a la app del
 * congelamiento de background (sin ella, One UI puede suspender el proceso a
 * media reproducción, con cortes/reanudaciones aleatorios). Best-effort.
 */
export function updatePositionState(durationMs: number, positionMs: number, rate = 1): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  if (typeof ms.setPositionState !== 'function') return;
  try {
    const duration = Math.max(0, durationMs / 1000);
    ms.setPositionState({
      duration,
      position: Math.min(duration, Math.max(0, positionMs / 1000)),
      playbackRate: rate > 0 ? rate : 1,
    });
  } catch {
    /* valores fuera de rango o API caprichosa: mejor sin position state */
  }
}

/** Limpia metadata y handlers (p. ej. al cerrar el documento). No-op si no existe. */
export function clearMediaSession(): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return;
  }
  const ms = navigator.mediaSession;
  ms.metadata = null;
  const actions: MediaSessionAction[] = [
    'play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward',
  ];
  for (const action of actions) {
    try {
      ms.setActionHandler(action, null);
    } catch {
      /* acción no soportada */
    }
  }
  try {
    ms.playbackState = 'none';
  } catch {
    /* no soportado */
  }
}
