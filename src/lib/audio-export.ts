import { chunkParagraph } from '../agents/chunker';
import { fetchTTS } from '../agents/tts-client';
import type { ExtractedDoc, TTSChunk } from '../types';

// ── Cancelación simple (AbortSignal-like) ───────────────────────────────
// No usamos AbortController real porque fetchTTS no acepta signal; basta con
// un flag que consultamos entre chunks para cortar de forma cooperativa.
export interface ExportCanceller {
  cancelled: boolean;
}

export function createCanceller(): ExportCanceller {
  return { cancelled: false };
}

// ── Resultado ───────────────────────────────────────────────────────────
export interface ExportResult {
  success: true;
  blob: Blob;
  chunkCount: number;
}

export interface ExportError {
  success: false;
  message: string;
  cancelled?: boolean;
}

const CHUNK_DELAY_MS = 150;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Exporta un capítulo completo a un único Blob MP3 (audio/mpeg).
 *
 * Para cada párrafo del capítulo: parte en chunks con chunkParagraph y pide el
 * MP3 crudo de cada chunk con fetchTTS (secuencial, con un pequeño delay para no
 * saturar el worker; los chunks ya cacheados en rawAudioCache salen gratis). Los
 * bytes de Edge TTS son un stream MPEG concatenable, así que se unen los
 * ArrayBuffers en orden en un solo Blob audio/mpeg.
 *
 * @param onProgress  (done, total) — total = número de chunks a sintetizar.
 * @param canceller   flag cooperativo; poner canceller.cancelled = true aborta.
 */
export async function exportChapterMP3(
  doc: ExtractedDoc,
  chapterIndex: number,
  voiceId: string,
  speed: number,
  onProgress?: (done: number, total: number) => void,
  canceller?: ExportCanceller,
): Promise<ExportResult | ExportError> {
  const chapter = doc.chapters[chapterIndex];
  if (!chapter) {
    return { success: false, message: `Capítulo ${chapterIndex} no existe.` };
  }

  // 1. Planear todos los chunks del capítulo (párrafo por párrafo) ────────
  const allChunks: TTSChunk[] = [];
  for (const paragraph of chapter.paragraphs) {
    if (!paragraph.text.trim()) continue;

    const planResult = chunkParagraph({
      paragraphId: paragraph.id,
      paragraphText: paragraph.text,
      voiceId,
      speed,
      maxChunkChars: 500,
      strategy: 'sentence',
    });

    if (!planResult.success) {
      return {
        success: false,
        message: `Error al segmentar un párrafo: ${planResult.error.message}`,
      };
    }

    allChunks.push(...planResult.data.chunks);
  }

  const total = allChunks.length;
  if (total === 0) {
    return { success: false, message: 'El capítulo no tiene texto para exportar.' };
  }

  onProgress?.(0, total);

  // 2. Sintetizar cada chunk en orden y juntar los ArrayBuffers ───────────
  const parts: ArrayBuffer[] = [];
  for (let i = 0; i < allChunks.length; i++) {
    if (canceller?.cancelled) {
      return { success: false, message: 'Exportación cancelada.', cancelled: true };
    }

    const chunk = allChunks[i];
    const result = await fetchTTS(chunk);

    if (!result.success) {
      return {
        success: false,
        message: `Error de TTS en el fragmento ${i + 1}/${total}: ${result.error.message}`,
      };
    }

    parts.push(result.data.audio);
    onProgress?.(i + 1, total);

    // Delay solo entre peticiones (no tras la última) para no saturar el worker.
    if (i < allChunks.length - 1) {
      await delay(CHUNK_DELAY_MS);
    }
  }

  // 3. Concatenar en un solo Blob MPEG ────────────────────────────────────
  const blob = new Blob(parts, { type: 'audio/mpeg' });
  return { success: true, blob, chunkCount: total };
}
