import { WordTiming } from './tts';

export type TimingStatus =
  | { status: 'idle' }
  | { status: 'fetching' }
  | { status: 'cached' }
  | { status: 'ready'; timings: WordTiming[] }
  | { status: 'error'; error: import('./errors').PipelineError };

export interface PlayerState {
  isPlaying: boolean;
  isBuffering: boolean;
  positionMs: number;
  wordIndex: number;
  /** Volumen maestro 0..1 aplicado por el GainNode del PlayerAgent. */
  volume: number;
}

// ── Media Session ─────────────────────────────────────────────────────────

/** Handlers que Media Session enruta a los controles de pantalla de bloqueo. */
export interface MediaSessionHandlers {
  play: () => void;
  pause: () => void;
  /** Siguiente párrafo. */
  next: () => void;
  /** Párrafo anterior. */
  prev: () => void;
  /** Salto al capítulo siguiente (opcional; mapeado a seekforward). */
  nextChapter?: () => void;
  /** Salto al capítulo anterior (opcional; mapeado a seekbackward). */
  prevChapter?: () => void;
}

export interface MediaSessionConfig {
  title: string;
  author?: string;
  chapter?: string;
  handlers: MediaSessionHandlers;
  /** Estado reflejado en la UI del SO. Por defecto 'playing'. */
  playbackState?: 'playing' | 'paused' | 'none';
}
