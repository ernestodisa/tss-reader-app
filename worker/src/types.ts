export type EngineId = 'edge' | 'elevenlabs' | 'openai';

export interface WordTiming {
  wordIndex: number;
  text: string;
  offsetMs: number;
  durationMs: number;
}

export interface TTSRequest {
  text: string;
  voiceId: string;
  speed: number;
  format: 'mp3' | 'ogg';
  engine?: EngineId;
}

export interface TTSEngine {
  synthesize(text: string, voiceId: string, speed: number): Promise<{
    audio: ArrayBuffer;
    words: WordTiming[];
    durationMs: number;
  }>;
}

export interface Env {
  TTS_CACHE?: R2Bucket;
  // Optional secrets — set via `wrangler secret put`. When absent, the
  // corresponding engine reports itself as not configured (400 on request).
  ELEVENLABS_API_KEY?: string;
  OPENAI_API_KEY?: string;
}
