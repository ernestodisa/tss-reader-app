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
}
