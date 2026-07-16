import type { TTSEngine, WordTiming } from './types';

// ElevenLabs TTS with character-level timestamps.
// POST /v1/text-to-speech/{voiceId}/with-timestamps returns JSON:
//   { audio_base64, alignment: { characters, character_start_times_seconds,
//     character_end_times_seconds }, normalized_alignment }
// We decode the base64 MP3 and collapse the char-level alignment into
// word timings by grouping characters between whitespace boundaries.

const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_MODEL = 'eleven_multilingual_v2';

interface ElevenAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface ElevenResponse {
  audio_base64: string;
  alignment: ElevenAlignment | null;
  normalized_alignment: ElevenAlignment | null;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Group char-level timings into words, splitting on whitespace.
function charsToWords(alignment: ElevenAlignment): WordTiming[] {
  const { characters, character_start_times_seconds, character_end_times_seconds } = alignment;
  const words: WordTiming[] = [];
  let wordChars = '';
  let wordStart = 0;
  let wordEnd = 0;
  let started = false;
  let wordIndex = 0;

  const flush = () => {
    const text = wordChars.trim();
    if (text.length > 0) {
      words.push({
        wordIndex: wordIndex++,
        text,
        offsetMs: Math.round(wordStart * 1000),
        durationMs: Math.max(0, Math.round((wordEnd - wordStart) * 1000)),
      });
    }
    wordChars = '';
    started = false;
  };

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (!started) {
      wordStart = character_start_times_seconds[i] ?? 0;
      started = true;
    }
    wordChars += ch;
    wordEnd = character_end_times_seconds[i] ?? wordStart;
  }
  flush();
  return words;
}

export function createElevenLabsEngine(apiKey: string): TTSEngine {
  return {
    async synthesize(text: string, voiceId: string, speed: number) {
      // ElevenLabs has no direct rate param on the classic endpoint; speed is
      // approximated by the voice_settings speed field (0.7–1.2 supported).
      const clampedSpeed = Math.min(1.2, Math.max(0.7, speed));
      const resp = await fetch(`${ELEVENLABS_URL}/${voiceId}/with-timestamps`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: DEFAULT_MODEL,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: clampedSpeed },
        }),
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`ElevenLabs HTTP ${resp.status}: ${detail.slice(0, 200)}`);
      }

      const data = (await resp.json()) as ElevenResponse;
      const audio = base64ToArrayBuffer(data.audio_base64);
      const alignment = data.alignment ?? data.normalized_alignment;
      const words = alignment ? charsToWords(alignment) : [];
      const durationMs =
        words.length > 0 ? words[words.length - 1].offsetMs + words[words.length - 1].durationMs : 0;

      return { audio, words, durationMs };
    },
  };
}
