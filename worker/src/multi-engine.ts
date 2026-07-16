import { edgeTTS } from './edge-tts';
import { createElevenLabsEngine } from './elevenlabs';
import { createOpenAIEngine } from './openai-tts';
import type { Env, EngineId, TTSEngine } from './types';

export interface EngineVoice {
  id: string;
  name: string;
  language: string;
  gender?: string;
}

export interface EngineInfo {
  id: EngineId;
  enabled: boolean;
  voices: EngineVoice[];
}

// Edge voices mirror the frontend's AVAILABLE_VOICES (src/types/tts.ts).
const EDGE_VOICES: EngineVoice[] = [
  { id: 'es-MX-DaliaNeural', name: 'Dalia', language: 'es-MX', gender: 'female' },
  { id: 'es-ES-ElviraNeural', name: 'Elvira', language: 'es-ES', gender: 'female' },
  { id: 'en-US-AriaNeural', name: 'Aria', language: 'en-US', gender: 'female' },
];

// Representative ElevenLabs public voices (voice IDs from the shared library).
const ELEVENLABS_VOICES: EngineVoice[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', language: 'en-US', gender: 'female' },
  { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi', language: 'en-US', gender: 'female' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni', language: 'en-US', gender: 'male' },
  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold', language: 'en-US', gender: 'male' },
];

// OpenAI TTS built-in voices for gpt-4o-mini-tts.
const OPENAI_VOICES: EngineVoice[] = [
  { id: 'alloy', name: 'Alloy', language: 'multi', gender: 'neutral' },
  { id: 'nova', name: 'Nova', language: 'multi', gender: 'female' },
  { id: 'shimmer', name: 'Shimmer', language: 'multi', gender: 'female' },
  { id: 'onyx', name: 'Onyx', language: 'multi', gender: 'male' },
];

export function isEngineConfigured(name: EngineId, env: Env): boolean {
  switch (name) {
    case 'edge':
      return true;
    case 'elevenlabs':
      return Boolean(env.ELEVENLABS_API_KEY);
    case 'openai':
      return Boolean(env.OPENAI_API_KEY);
    default:
      return false;
  }
}

// Resolve a concrete engine instance, or null when the requested engine has no
// API key configured. Edge is always available.
export function resolveEngine(name: EngineId, env: Env): TTSEngine | null {
  switch (name) {
    case 'edge':
      return edgeTTS;
    case 'elevenlabs':
      return env.ELEVENLABS_API_KEY ? createElevenLabsEngine(env.ELEVENLABS_API_KEY) : null;
    case 'openai':
      return env.OPENAI_API_KEY ? createOpenAIEngine(env.OPENAI_API_KEY) : null;
    default:
      return null;
  }
}

export function listEngines(env: Env): EngineInfo[] {
  return [
    { id: 'edge', enabled: true, voices: EDGE_VOICES },
    { id: 'elevenlabs', enabled: isEngineConfigured('elevenlabs', env), voices: ELEVENLABS_VOICES },
    { id: 'openai', enabled: isEngineConfigured('openai', env), voices: OPENAI_VOICES },
  ];
}
