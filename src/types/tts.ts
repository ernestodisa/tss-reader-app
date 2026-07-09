export interface WordTiming {
  wordIndex: number;
  text: string;
  offsetMs: number;
  durationMs: number;
}

export interface TTSResponse {
  chunkId: string;
  audio: ArrayBuffer;
  format: 'mp3' | 'ogg';
  words: WordTiming[];
  durationMs: number;
}

export interface VoiceConfig {
  id: string;
  name: string;
  language: string;
  gender?: string;
  engine: 'edge' | 'elevenlabs' | 'openai' | 'playht';
  sampleRate?: number;
}

export const AVAILABLE_VOICES: VoiceConfig[] = [
  { id: 'es-MX-DaliaNeural', name: 'Dalia', language: 'es-MX', gender: 'female', engine: 'edge' },
  { id: 'es-ES-ElviraNeural', name: 'Elvira', language: 'es-ES', gender: 'female', engine: 'edge' },
  { id: 'en-US-AriaNeural', name: 'Aria', language: 'en-US', gender: 'female', engine: 'edge' },
];
