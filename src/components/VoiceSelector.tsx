import { useEffect, useRef, useState } from 'react';
import { usePlayback } from '../hooks/usePlayback';
import { AVAILABLE_VOICES, encodeVoiceId, decodeVoiceId } from '../types/tts';
import type { EngineId, EnginesResponse, RemoteEngineInfo } from '../types/tts';

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787';

// Etiqueta corta para la pill ("Motor ▾") y encabezado de columna del popover.
const ENGINE_LABELS: Record<EngineId, string> = {
  edge: 'Edge',
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI',
  playht: 'PlayHT',
};
const ENGINE_COL_TITLES: Record<EngineId, string> = {
  edge: 'Edge TTS · Gratis',
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (enginesCache) return;
    fetchEngines().then(setRemoteEngines);
  }, []);

  // Cerrar el popover al hacer click fuera.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Conserva el encoding engine::voiceId del catálogo actual.
  const { engine: currentEngine, voiceId: currentVoiceId } = decodeVoiceId(voiceId);
  const selectedValue = encodeVoiceId(currentEngine, currentVoiceId);

  const groups: { engine: EngineId; voices: { id: string; name: string; language: string }[] }[] =
    remoteEngines && remoteEngines.length > 0
      ? remoteEngines
          .filter((e) => e.enabled)
          .map((e) => ({ engine: e.id, voices: e.voices }))
      : [{ engine: 'edge', voices: AVAILABLE_VOICES.filter((v) => v.engine === 'edge') }];

  // Nombre de la voz seleccionada para mostrar en la pill (fallback al id crudo).
  let selectedName = currentVoiceId;
  for (const g of groups) {
    const v = g.voices.find((vv) => vv.id === currentVoiceId);
    if (v) {
      selectedName = v.name;
      break;
    }
  }

  const handlePick = (value: string) => {
    setVoice(value);
    setOpen(false);
  };

  return (
    <div className="fp-voice" ref={rootRef}>
      <button
        type="button"
        className="fp-voice-pill"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className="fp-voice-dot" aria-hidden="true" />
        <span className="fp-voice-name">{selectedName}</span>
        <span className="fp-voice-engine">{ENGINE_LABELS[currentEngine] ?? currentEngine} ▾</span>
      </button>

      {open && (
        <div className="fp-voice-popover" role="menu">
          {groups.map((group) => (
            <div className="fp-voice-col" key={group.engine}>
              <div className="fp-voice-col-title">
                {ENGINE_COL_TITLES[group.engine] ?? group.engine}
              </div>
              {group.voices.map((voice) => {
                const value = encodeVoiceId(group.engine, voice.id);
                const isSel = value === selectedValue;
                return (
                  <button
                    type="button"
                    key={value}
                    className={`fp-voice-opt${isSel ? ' selected' : ''}`}
                    onClick={() => handlePick(value)}
                    role="menuitemradio"
                    aria-checked={isSel}
                  >
                    <span className="fp-voice-opt-name">{voice.name}</span>
                    <span className="fp-voice-opt-lang">{voice.language}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
