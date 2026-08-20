import { WordTiming } from '../types';

// ── Tipos de callback (compartidos por todos los motores) ─────────────────

export type WordChangeCallback = (wordIndex: number) => void;
export type EndCallback = () => void;
export type ErrorCallback = () => void;
/** Metadatos del chunk PRE-ENCOLADO que arranca solo al cruzar su frontera. */
export interface QueuedChunkMeta {
  paragraphId: string;
  /** true si este chunk es el primero del SIGUIENTE párrafo (auto-avance). */
  paragraphAdvance: boolean;
}
export type ChunkStartCallback = (meta: QueuedChunkMeta, timings: WordTiming[]) => void;
export type PlayBlockedCallback = () => void;
/** Pausa INESPERADA del elemento (interrupción del sistema: llamada, Siri,
 *  otra app tomó el audio). No se dispara en pausas iniciadas por la app. */
export type SystemPauseCallback = () => void;

// ── Interfaz de motor de reproducción ─────────────────────────────────────
// Contrato ÚNICO que consume PlayerBar. Existen dos implementaciones:
//   • PlayerAgent (player.ts)     → motor clásico: un <audio> con swap síncrono
//     de `src` en `ended`. Es el motor iOS/fallback y NO debe cambiar de
//     comportamiento (en iPhone el MediaSource clásico no existe).
//   • MseEngine (mse-player.ts)   → motor de stream continuo vía MediaSource:
//     un solo `src`, los chunks MP3 se anexan al SourceBuffer por JS. Android
//     sí permite anexar media en background con la pantalla apagada.
// El parámetro `durationMs` es opcional: el motor clásico lo ignora; el MSE lo
// acepta como pista (aunque deriva la duración real de los rangos `buffered`).
export interface PlaybackEngine {
  /**
   * iOS: activa el elemento <audio> con el gesto del usuario (clip mudo) y
   * declara la sesión de audio como 'playback'. DEBE llamarse SÍNCRONAMENTE
   * dentro del handler del toque, antes de cualquier `await`: el `play()` real
   * llega después del fetch TTS y Safari lo rechazaría por falta de gesto.
   * Idempotente; no-op cuando el elemento ya está desbloqueado o ya tiene
   * contenido real cargado.
   */
  unlock(): void;
  /** Carga un párrafo: reinicia el stream y arranca por el primer chunk. */
  load(paragraphId: string, mp3Parts: ArrayBuffer[], timings: WordTiming[], durationMs?: number): void;
  play(): void;
  pause(): void;
  resume(): void;
  /** Pre-encola el SIGUIENTE chunk (mismo párrafo o primero del siguiente). */
  queueNext(mp3Parts: ArrayBuffer[], timings: WordTiming[], meta: QueuedChunkMeta, durationMs?: number): void;
  /**
   * A5: señala si hay al menos un fetch EN VUELO que alimentará la reproducción
   * actual (siguiente chunk del párrafo o primer chunk del párrafo gapless).
   * El motor MSE lo usa para NO confundir un underrun de red (buffer drenado
   * mientras el chunk que sigue aún se descarga) con el fin real del stream. El
   * motor clásico lo ignora (no-op): reasigna `src` por chunk y no tiene el
   * concepto de "stream drenado a la espera de más datos anexados".
   */
  setExpectingMore(expecting: boolean): void;
  fullStop(): void;
  /** ms RELATIVOS al chunk/párrafo actual (no al stream completo). */
  getCurrentPositionMs(): number;
  setVolume(volume: number): void;
  getVolume(): number;
  destroy(): void;
  setWordChangeCallback(cb: WordChangeCallback): void;
  setEndCallback(cb: EndCallback): void;
  setErrorCallback(cb: ErrorCallback): void;
  setChunkStartCallback(cb: ChunkStartCallback): void;
  setPlayBlockedCallback(cb: PlayBlockedCallback): void;
  /**
   * true si el <audio> está realmente sonando (no pausado ni terminado y con
   * contenido cargado). Lo usa el watchdog de regreso a foreground: iOS puede
   * suspender el JS en un hueco de silencio y la cadena muere con el store en
   * isPlaying=true — al volver a visible, si esto es false, hay que retomar.
   */
  isPlayingAudio(): boolean;
  /** Interrupción del sistema (ver SystemPauseCallback). */
  setSystemPauseCallback(cb: SystemPauseCallback): void;
}
