import type { TTSEngine, WordTiming } from './types';

// OpenAI TTS. POST /v1/audio/speech (model gpt-4o-mini-tts) returns raw audio
// bytes and NO timing information. We therefore synthesize word timings
// proportionally to each word's character length across an ESTIMATED duration.
//
// The real audio duration is NOT known inside the Worker (decoding MP3 to read
// its length would be far too expensive), so we approximate playback rate at
// ~15 characters/second of spoken text, scaled by the requested speed. This is
// a heuristic — karaoke highlighting will drift on very long chunks. Chunks are
// short (<=2000 chars) so drift stays tolerable, and the client can re-sync on
// the audio element's real currentTime if desired.

const OPENAI_URL = 'https://api.openai.com/v1/audio/speech';
const MODEL = 'gpt-4o-mini-tts';
// Baseline spoken rate; higher speed compresses the estimated timeline.
const CHARS_PER_SEC = 15;

// Split into words while keeping their original order; punctuation stays glued
// to the adjacent word so the timing count matches the text as read.
function synthesizeTimings(text: string, speed: number): { words: WordTiming[]; durationMs: number } {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  const effectiveRate = CHARS_PER_SEC * (speed > 0 ? speed : 1);
  const totalChars = tokens.reduce((sum, t) => sum + t.length, 0) || 1;
  const totalMs = Math.round((totalChars / effectiveRate) * 1000);

  const words: WordTiming[] = [];
  let cursorMs = 0;
  tokens.forEach((token, i) => {
    const share = token.length / totalChars;
    const durationMs = Math.round(share * totalMs);
    words.push({ wordIndex: i, text: token, offsetMs: cursorMs, durationMs });
    cursorMs += durationMs;
  });

  return { words, durationMs: cursorMs };
}

export function createOpenAIEngine(apiKey: string): TTSEngine {
  return {
    async synthesize(text: string, voiceId: string, speed: number) {
      // OpenAI accepts speed in [0.25, 4.0].
      const clampedSpeed = Math.min(4.0, Math.max(0.25, speed || 1.0));
      const resp = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          input: text,
          voice: voiceId,
          speed: clampedSpeed,
          response_format: 'mp3',
        }),
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`OpenAI HTTP ${resp.status}: ${detail.slice(0, 200)}`);
      }

      const audio = await resp.arrayBuffer();
      // No timings from the API — generate synthetic ones proportional to word
      // length over an estimated duration (see CHARS_PER_SEC note above).
      const { words, durationMs } = synthesizeTimings(text, clampedSpeed);

      return { audio, words, durationMs };
    },
  };
}
