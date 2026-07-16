import { useState } from 'react';
import { useDocumentStore } from '../store/document-store';
import { usePlaybackStore } from '../store/playback-store';
import {
  exportChapterMP3,
  createCanceller,
  type ExportCanceller,
} from '../lib/audio-export';

// ── Estado del botón como discriminated union ───────────────────────────
type ExportState =
  | { status: 'idle' }
  | { status: 'exporting'; done: number; total: number; canceller: ExportCanceller }
  | { status: 'error'; message: string };

// Slug seguro para el nombre de archivo (sin acentos ni caracteres raros).
function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'audio';
}

export function ExportButton() {
  const doc = useDocumentStore((s) => s.doc);
  const chapterIndex = usePlaybackStore((s) => s.chapterIndex);
  const voiceId = usePlaybackStore((s) => s.voiceId);
  const speed = usePlaybackStore((s) => s.speed);

  const [state, setState] = useState<ExportState>({ status: 'idle' });

  if (!doc) return null;

  const handleExport = async () => {
    const canceller = createCanceller();
    setState({ status: 'exporting', done: 0, total: 0, canceller });

    const result = await exportChapterMP3(
      doc,
      chapterIndex,
      voiceId,
      speed,
      (done, total) =>
        setState((prev) =>
          prev.status === 'exporting'
            ? { ...prev, done, total }
            : prev,
        ),
      canceller,
    );

    if (!result.success) {
      if (result.cancelled) {
        setState({ status: 'idle' });
      } else {
        setState({ status: 'error', message: result.message });
      }
      return;
    }

    // ── Descargar el Blob vía object URL ──────────────────────────────
    const url = URL.createObjectURL(result.blob);
    try {
      const base = slugify(doc.title || 'audio');
      const capN = `cap${chapterIndex + 1}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `${base}-${capN}.mp3`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }

    setState({ status: 'idle' });
  };

  const handleCancel = () => {
    if (state.status === 'exporting') {
      state.canceller.cancelled = true;
    }
  };

  if (state.status === 'exporting') {
    const pct =
      state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
    // El fondo del pill es un gradiente de progreso (spec §Lector · Exportar).
    const background = `linear-gradient(to right, color-mix(in oklab, var(--accent) 30%, var(--bg3)) ${pct}%, var(--bg3) ${pct}%)`;
    return (
      <button
        type="button"
        className="export-pill exporting"
        style={{ background }}
        onClick={handleCancel}
        title="Cancelar exportación"
        aria-label={`Exportando ${pct}% — clic para cancelar`}
      >
        Exportando… {pct}%
      </button>
    );
  }

  return (
    <span className="export-pill-wrap">
      <button type="button" className="export-pill" onClick={handleExport}>
        Exportar MP3
      </button>
      {state.status === 'error' && (
        <span className="export-error" role="alert">
          {state.message}
        </span>
      )}
    </span>
  );
}
