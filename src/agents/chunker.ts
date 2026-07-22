import { chunkId } from '../lib/hash';
import { decodeVoiceId } from '../types/tts';
import type { AgentResult, ChunkJob, ChunkPlan, TTSChunk, PipelineError } from '../types';

// Unidad procesable ≈ 1-2 oraciones: arranque rápido en párrafos grandes.
const DEFAULT_MAX_CHARS = 250;

export function chunkParagraph(job: ChunkJob): AgentResult<ChunkPlan> {
  const maxChars = job.maxChunkChars || DEFAULT_MAX_CHARS;

  // El job.voiceId puede venir codificado como "engine::voiceId" (lo que setea
  // VoiceSelector) o crudo (default/persistido legado). Se decodifica una vez:
  // los chunks llevan el voiceId crudo que espera el worker + el motor aparte.
  const { engine, voiceId } = decodeVoiceId(job.voiceId);

  try {
    const chunks: TTSChunk[] = [];
    const wordOffsetMap = new Map<number, number>(); // global wordIndex → chunkIndex

    // Párrafo SIN contenido pronunciable (separadores tipográficos "• • •",
    // ". . .", "***", líneas de adorno): Edge TTS responde 200 con 0 bytes y la
    // reproducción se plantaba ahí reintentando. Cero chunks → el PlayerBar lo
    // salta de inmediato por su camino de "párrafo sin contenido sonoro".
    if (!/[\p{L}\p{N}]/u.test(job.paragraphText)) {
      return {
        success: true,
        data: { paragraphId: job.paragraphId, chunks, estimatedDurationMs: 0, wordOffsetMap },
      };
    }

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
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) || [text];
  // Una "oración" sin puntuación puede exceder por sí sola el tope del chunk
  // (índices, tablas, texto corrido) y el worker rechaza >2000 chars con
  // text_too_long — el párrafo quedaba atorado para siempre. Partimos las
  // oraciones gigantes por el último espacio antes del límite.
  //
  // B7 — nunca partir una PALABRA a media (URLs/hashes/tablas sin espacios):
  // el karaoke cuenta palabras con split(/\s+/) tanto en el párrafo completo
  // (KaraokeText) como al acumular chain.wordOffset por chunk (PlayerBar). Si un
  // corte duro parte "foobar" en "foo"+"bar", el párrafo lo cuenta como 1 token
  // pero los chunks suman 2 → wordOffset se corre +1 y el seguimiento por palabra
  // muere el resto del párrafo. Solución elegida (la más simple que mantiene el
  // conteo consistente): al no haber espacio dentro de la ventana objetivo,
  // mantener la palabra ENTERA en un solo chunk aunque exceda HARD_LIMIT, hasta
  // el tope REAL del worker (WORKER_MAX < 2000). Así un run monolítico queda como
  // UN token en un chunk y el conteo cuadra. Solo un run monolítico > WORKER_MAX
  // (patológico, prácticamente inexistente) se parte a media palabra; ahí se
  // acepta el desfase de conteo — ese token ya no es "karaokeable" de todos modos.
  const HARD_LIMIT = 230; // tamaño objetivo (calidad TTS / arranque rápido)
  const WORKER_MAX = 1900; // tope real del worker (rechaza text.length > 2000)
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= HARD_LIMIT) {
      out.push(s);
      continue;
    }
    let rest = s;
    while (rest.length > HARD_LIMIT) {
      let cut = rest.lastIndexOf(' ', HARD_LIMIT);
      if (cut <= 0) {
        // Sin espacio en la ventana objetivo: no partimos la palabra ahí.
        // Buscamos el PRÓXIMO espacio (deja la palabra entera) o el fin del
        // texto; solo si eso supera el tope del worker cortamos a media palabra.
        const nextSpace = rest.indexOf(' ', HARD_LIMIT);
        cut = nextSpace === -1 ? rest.length - 1 : nextSpace;
        if (cut + 1 > WORKER_MAX) cut = WORKER_MAX - 1;
      }
      out.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    if (rest) out.push(rest);
  }
  return out;
}