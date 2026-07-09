import { usePlayback } from '../hooks/usePlayback';
import { AVAILABLE_VOICES } from '../types/tts';

export function VoiceSelector() {
  const { voiceId, setVoice } = usePlayback();

  return (
    <select
      value={voiceId}
      onChange={(e) => setVoice(e.target.value)}
      className="voice-selector"
    >
      {AVAILABLE_VOICES.map((voice) => (
        <option key={voice.id} value={voice.id}>
          {voice.name} ({voice.language})
        </option>
      ))}
    </select>
  );
}
