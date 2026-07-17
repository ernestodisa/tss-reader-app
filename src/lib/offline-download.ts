// Descarga offline por capítulo: pre-genera y cachea TODO el audio TTS de un
// capítulo reutilizando el pipeline normal (chunkParagraph + fetchTTS, mismas
// llaves de cache), de modo que la reproducción posterior funcione sin red.
//
// Importante: la llave de cada chunk incluye VOZ y VELOCIDAD — una descarga
// vale para la combinación activa al momento de descargar. Si el usuario
// cambia de voz o velocidad, ese capítulo vuelve a necesitar red.

import { chunkParagraph } from '../agents/chunker';
import { fetchTTS, hasCachedChunk } from '../agents/tts-client';
import { usePlaybackStore } from '../store/playback-store';
import type { ExtractedDoc, TTSChunk } from '../types';

const CONCURRENCY = 2; // Edge TTS es frágil; no lo saturamos
const MAX_RETRIES = 3;

export interface ChapterDownloadProgress {
  done: number;
  total: number;
  failed: number;
}

/** Todos los chunks del capítulo con la voz/velocidad ACTUALES del player. */
function chapterChunks(doc: ExtractedDoc, chapterIndex: number): TTSChunk[] {
  const chapter = doc.chapters[chapterIndex];
  if (!chapter) return [];
  const { voiceId, speed } = usePlaybackStore.getState();
  const chunks: TTSChunk[] = [];
  for (const p of chapter.paragraphs) {
    const r = chunkParagraph({
      paragraphId: p.id,
      paragraphText: p.text,
      voiceId,
      speed,
      maxChunkChars: 250,
      strategy: 'sentence',
    });
    if (r.success) chunks.push(...r.data.chunks);
  }
  return chunks;
}

/** ¿El capítulo completo ya está en cache para la voz/velocidad actuales? */
export async function isChapterDownloaded(
  doc: ExtractedDoc,
  chapterIndex: number,
): Promise<boolean> {
  const chunks = chapterChunks(doc, chapterIndex);
  if (chunks.length === 0) return false;
  for (const c of chunks) {
    if (!(await hasCachedChunk(c.id))) return false;
  }
  return true;
}

/** Pide almacenamiento persistente UNA vez (iOS purga IndexedDB bajo presión
 *  de disco si no). Silencioso: si el navegador dice que no, seguimos igual. */
let persistRequested = false;
async function requestPersistentStorage(): Promise<void> {
  if (persistRequested) return;
  persistRequested = true;
  try {
    await navigator.storage?.persist?.();
  } catch {
    // opcional; sin consecuencias
  }
}

/**
 * Descarga (cachea) todo el audio del capítulo. Reporta avance por chunk y
 * respeta la señal de cancelación. Devuelve el conteo final; `failed > 0`
 * significa descarga incompleta (reintentable — lo ya bajado queda en cache).
 */
export async function downloadChapterAudio(
  doc: ExtractedDoc,
  chapterIndex: number,
  onProgress: (p: ChapterDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<ChapterDownloadProgress> {
  await requestPersistentStorage();

  const chunks = chapterChunks(doc, chapterIndex);
  const progress: ChapterDownloadProgress = { done: 0, total: chunks.length, failed: 0 };
  onProgress({ ...progress });

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < chunks.length) {
      if (signal?.aborted) return;
      const chunk = chunks[next++];

      // fetchTTS ya consulta el cache primero: los chunks presentes cuentan
      // como hechos sin tocar la red.
      let ok = false;
      for (let attempt = 0; attempt < MAX_RETRIES && !ok; attempt++) {
        if (signal?.aborted) return;
        const result = await fetchTTS(chunk);
        if (result.success) {
          ok = true;
        } else if (result.error.recoverable) {
          // 429/red: espera lo que pida el worker y reintenta.
          await new Promise((r) => setTimeout(r, result.error.retryAfterMs ?? 1500));
        } else {
          break; // error duro: no insistir con este chunk
        }
      }

      if (ok) progress.done++;
      else progress.failed++;
      onProgress({ ...progress });
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return progress;
}
