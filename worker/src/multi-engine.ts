import { edgeTTS } from './edge-tts';
import type { TTSEngine } from './types';

type EngineName = 'edge';

const engines: Record<EngineName, TTSEngine> = {
  edge: edgeTTS,
};

export function getEngine(name: EngineName = 'edge'): TTSEngine {
  return engines[name] ?? engines.edge;
}
