export interface TTSRequest {
  text: string;
  voiceId: string;
  speed: number;
  format: 'mp3' | 'ogg';
}

export interface TTSEngine {
  synthesize(text: string, voiceId: string, speed: number): Promise<{
    audio: ArrayBuffer;
    words: { wordIndex: number; text: string; offsetMs: number; durationMs: number }[];
    durationMs: number;
  }>;
}

export interface Env {
  TTS_CACHE?: R2Bucket;
}
