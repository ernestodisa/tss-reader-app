import { chunkId } from '../lib/hash';
import { decodeVoiceId } from '../types/tts';
import type { AgentResult, ChunkJob, ChunkPlan, TTSChunk, PipelineError } from '../types';

const DEFAULT_MAX_CHARS = 500;

export function chunkParagraph(job: ChunkJob): AgentResult<ChunkPlan> {
  const maxChars = job.maxChunkChars || DEFAULT_MAX_CHARS;

  // El job.voiceId puede venir codificado como "engine::voiceId" (lo que setea
  // VoiceSelector) o crudo (default/persistido legado). Se decodifica una vez:
  // los chunks llevan el voiceId crudo que espera el worker + el motor aparte.
  const { engine, voiceId } = decodeVoiceId(job.voiceId);

  try {
    const chunks: TTSChunk[] = [];
    const wordOffsetMap = new Map<number, number>(); // global wordIndex → chunkIndex

    if (job.paragraphText.length <= maxChars) {
      // Single chunk — no splitting needed
      const chunk: TTSChunk = {
        id: chunkId(job.paragraphText, voiceId, job.speed, engine),
        paragraphId: job.paragraphId,
        chunkIndex: 0,
        text: job.paragraphText,
        voiceId,
        engine,
        speed: job.speed,
      };
      chunks.push(chunk);

      // Map all words to chunk 0
      const wordCount = job.paragraphText.split(/\s+/).length;
      for (let i = 0; i < wordCount; i++) {
        wordOffsetMap.set(i, 0);
      }
    } else {
      // Split by sentence boundaries
      const sentences = splitBySentence(job.paragraphText);
      let currentChunkText = '';
      let currentChunkIndex = 0;
      let globalWordIndex = 0;

      for (const sentence of sentences) {
        if (currentChunkText.length + sentence.length + 1 > maxChars && currentChunkText.length > 0) {
          // Flush current chunk
          const chunk: TTSChunk = {
            id: chunkId(currentChunkText, voiceId, job.speed, engine),
            paragraphId: job.paragraphId,
            chunkIndex: currentChunkIndex,
            text: currentChunkText.trim(),
            voiceId,
            engine,
            speed: job.speed,
          };
          chunks.push(chunk);
          currentChunkText = '';
          currentChunkIndex++;
        }

        // Map words in this sentence to current chunk index
        const wordCount = sentence.split(/\s+/).filter(Boolean).length;
        for (let i = 0; i < wordCount; i++) {
          wordOffsetMap.set(globalWordIndex, currentChunkIndex);
          globalWordIndex++;
        }

        currentChunkText += (currentChunkText ? ' ' : '') + sentence;
      }

      // Flush remaining
      if (currentChunkText.trim()) {
        const chunk: TTSChunk = {
          id: chunkId(currentChunkText, voiceId, job.speed, engine),
          paragraphId: job.paragraphId,
          chunkIndex: currentChunkIndex,
          text: currentChunkText.trim(),
          voiceId,
          engine,
          speed: job.speed,
        };
        chunks.push(chunk);
      }
    }

    // Estimate duration: ~15 chars/sec at 1x speed
    const estimatedDurationMs = Math.round(
      (job.paragraphText.length / 15) * 1000 / job.speed
    );

    return {
      success: true,
      data: {
        paragraphId: job.paragraphId,
        chunks,
        estimatedDurationMs,
        wordOffsetMap,
      },
    };
  } catch (err) {
    const error: PipelineError = {
      step: 'chunk',
      paragraphId: job.paragraphId,
      code: 'chunk_failed',
      message: err instanceof Error ? err.message : 'unknown chunking error',
      recoverable: false,
    };
    return { success: false, error };
  }
}

function splitBySentence(text: string): string[] {
  // Split on sentence boundaries while preserving the delimiter
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g);
  return sentences || [text];
}