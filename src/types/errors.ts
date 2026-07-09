export type PipelineStep = 'extract' | 'chunk' | 'tts' | 'play';

export interface PipelineError {
  step: PipelineStep;
  paragraphId?: string;
  chunkId?: string;
  code: string;
  message: string;
  recoverable: boolean;
  retryAfterMs?: number;
}

export type AgentResult<T> =
  | { success: true; data: T }
  | { success: false; error: PipelineError };
