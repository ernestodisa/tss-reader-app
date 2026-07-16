import type { EngineId } from './tts';

export interface TTSChunk {
  id: string;
  paragraphId: string;
  chunkIndex: number;
  text: string;
  /** voiceId "crudo" que espera el worker (sin prefijo de motor). */
  voiceId: string;
  /** Motor TTS resuelto para este chunk (decodificado del voiceId del store). */
  engine: EngineId;
  speed: number;
}

export interface ChunkJob {
  paragraphId: string;
  paragraphText: string;
  voiceId: string;
  speed: number;
  maxChunkChars: number;
  strategy: 'sentence' | 'fixed' | 'paragraph';
}

export interface ChunkPlan {
  paragraphId: string;
  chunks: TTSChunk[];
  estimatedDurationMs: number;
  wordOffsetMap: Map<number, number>;
}
