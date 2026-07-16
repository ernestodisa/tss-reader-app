import { useEffect, useState } from 'react';
import { usePlayback } from '../hooks/usePlayback';
import { AVAILABLE_VOICES, encodeVoiceId, decodeVoiceId } from '../types/tts';
import type { EngineId, EnginesResponse, RemoteEngineInfo } from '../types/tts';

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787';

const ENGINE_LABELS: Record<EngineId, string> = {
  edge: 'Edge TTS (gratis)',
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI',
  playht: 'PlayHT',
};

// Cache en memoria del catálogo del worker — se comparte entre montajes del
// componente dentro de la misma pestaña, evitando refetch en cada render.
let enginesCache: RemoteEngineInfo[] | null = null;
let enginesPromise: Promise<RemoteEngineInfo[]> | null = null;

async function fetchEngines(): Promise<RemoteEngineInfo[]> {
  if (enginesCache) return enginesCache;
  if (!enginesPromise) {
    enginesPromise = fetch(`${WORKER_URL}/engines`)
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json() as Promise<EnginesResponse>;
      })
      .then((data) => {
        enginesCache = data.engines;
        return data.engines;
      })
      .catch(() => {
        // Sin conexión al worker: cae de vuelta al catálogo local (solo Edge).
        enginesPromise = null;
        return [];
      });
  }
  return enginesPromise;
}

export function VoiceSelector() {
  const { voiceId, setVoice } = usePlayback();
  const [remoteEngines, setRemoteEngines] = useState<RemoteEngineInfo[] | null>(enginesCache);

  useEffect(() => {
    if (enginesCache) return;
    fetchEngines().then(setRemoteEngines);
  }, []);

  // Codifica el voiceId actual con su motor para que el <select> lo reconozca
  // entre grupos (si ya viene con prefijo "engine::", se respeta tal cual).
  const { engine: currentEngine, voiceId: currentVoiceId } = decodeVoiceId(voiceId);
  const selectedValue = encodeVoiceId(currentEngine, currentVoiceId);

  const groups: { engine: EngineId; voices: { id: string; name: string; language: string }[] }[] =
    remoteEngines && remoteEngines.length > 0
      ? remoteEngines
          .filter((e) => e.enabled)
          .map((e) => ({ engine: e.id, voices: e.voices }))
      : [{ engine: 'edge', voices: AVAILABLE_VOICES.filter((v) => v.engine === 'edge') }];

  return (
    <select
      value={selectedValue}
      onChange={(e) => setVoice(e.target.value)}
      className="voice-selector"
    >
      {groups.map((group) => (
        <optgroup key={group.engine} label={ENGINE_LABELS[group.engine] ?? group.engine}>
          {group.voices.map((voice) => (
            <option key={`${group.engine}::${voice.id}`} value={encodeVoiceId(group.engine, voice.id)}>
              {voice.name} ({voice.language})
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
