export interface TTSChunk {
  id: string;
  paragraphId: string;
  chunkIndex: number;
  text: string;
  voiceId: string;
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
