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

export type EngineId = 'edge' | 'elevenlabs' | 'openai' | 'playht';

export interface VoiceConfig {
  id: string;
  name: string;
  language: string;
  gender?: string;
  engine: EngineId;
  sampleRate?: number;
}

export const AVAILABLE_VOICES: VoiceConfig[] = [
  { id: 'es-MX-DaliaNeural', name: 'Dalia', language: 'es-MX', gender: 'female', engine: 'edge' },
  { id: 'es-ES-ElviraNeural', name: 'Elvira', language: 'es-ES', gender: 'female', engine: 'edge' },
  { id: 'en-US-AriaNeural', name: 'Aria', language: 'en-US', gender: 'female', engine: 'edge' },
];

/**
 * Voz reportada por el worker en GET /engines (worker/src/multi-engine.ts:EngineVoice).
 * No incluye `engine` — se agrega al agrupar por motor en EngineCatalog.
 */
export interface RemoteEngineVoice {
  id: string;
  name: string;
  language: string;
  gender?: string;
}

export interface RemoteEngineInfo {
  id: EngineId;
  enabled: boolean;
  voices: RemoteEngineVoice[];
}

/** Respuesta cruda de GET /engines. */
export interface EnginesResponse {
  engines: RemoteEngineInfo[];
}

/**
 * Identificador de voz "codificado" con su motor: "engine::voiceId".
 * El chunker (agents/chunker.ts) decodifica este prefijo: guarda el voiceId crudo
 * y el `engine` por separado en cada TTSChunk, y tts-client manda ambos en el body
 * de POST /tts. El `engine` también entra en la clave de caché (lib/hash.ts).
 */
export type EncodedVoiceId = `${EngineId}::${string}`;

export function encodeVoiceId(engine: EngineId, voiceId: string): EncodedVoiceId {
  return `${engine}::${voiceId}`;
}

export function decodeVoiceId(encoded: string): { engine: EngineId; voiceId: string } {
  const sep = encoded.indexOf('::');
  if (sep === -1) {
    // Compatibilidad hacia atrás: voiceId sin prefijo → asume 'edge'.
    return { engine: 'edge', voiceId: encoded };
  }
  return {
    engine: encoded.slice(0, sep) as EngineId,
    voiceId: encoded.slice(sep + 2),
  };
}
