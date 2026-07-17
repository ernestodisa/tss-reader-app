import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlaybackStore } from '../store/playback-store';
import {
  downloadChapterAudio,
  isChapterDownloaded,
  type ChapterDownloadProgress,
} from '../lib/offline-download';
import type { ExtractedDoc } from '../types';

interface Props {
  doc: ExtractedDoc;
  chapterIndex: number;
}

type Status = 'checking' | 'idle' | 'downloading' | 'done' | 'partial';

/**
 * Botón "descargar capítulo para offline" del header del lector. Estados:
 * ⬇ descargar → n/m descargando (tocar = cancelar) → ✓ listo sin conexión.
 * La descarga vale para la voz/velocidad activas (la llave del cache las
 * incluye): al cambiarlas se re-evalúa el estado.
 */
export function OfflineDownloadButton({ doc, chapterIndex }: Props) {
  const [status, setStatus] = useState<Status>('checking');
  const [progress, setProgress] = useState<ChapterDownloadProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Solo primitivos del store (gotcha React 19 + Zustand: nada de objetos nuevos).
  const voiceId = usePlaybackStore((s) => s.voiceId);
  const speed = usePlaybackStore((s) => s.speed);

  // Re-evalúa si el capítulo ya está completo al cambiar capítulo/voz/velocidad.
  useEffect(() => {
    let alive = true;
    abortRef.current?.abort(); // un cambio de contexto cancela la descarga en curso
    setStatus('checking');
    setProgress(null);
    void isChapterDownloaded(doc, chapterIndex).then((full) => {
      if (alive) setStatus(full ? 'done' : 'idle');
    });
    return () => {
      alive = false;
    };
  }, [doc, chapterIndex, voiceId, speed]);

  useEffect(() => () => abortRef.current?.abort(), []); // desmontar = cancelar

  const handleClick = useCallback(async () => {
    if (status === 'downloading') {
      abortRef.current?.abort();
      setStatus('idle');
      return;
    }
    if (status === 'done' || status === 'checking') return;

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('downloading');
    const result = await downloadChapterAudio(
      doc,
      chapterIndex,
      (p) => setProgress({ ...p }),
      controller.signal,
    );
    if (controller.signal.aborted) return; // el estado ya lo puso quien canceló
    setStatus(result.failed > 0 ? 'partial' : 'done');
  }, [status, doc, chapterIndex]);

  const label =
    status === 'downloading' && progress
      ? `${progress.done}/${progress.total}`
      : status === 'done'
        ? '✓'
        : status === 'partial'
          ? '⬇ reintentar'
          : '⬇';

  const title =
    status === 'done'
      ? 'Capítulo disponible sin conexión (con la voz y velocidad actuales)'
      : status === 'downloading'
        ? 'Descargando audio del capítulo… toca para cancelar'
        : status === 'partial'
          ? 'Descarga incompleta — toca para reintentar lo que falta'
          : 'Descargar el audio del capítulo para escucharlo sin conexión';

  return (
    <button
      type="button"
      className="offline-dl"
      data-status={status}
      onClick={handleClick}
      disabled={status === 'checking'}
      aria-label={title}
      title={title}
    >
      {label}
    </button>
  );
}
