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
    return (
      <div className="export-button exporting">
        <div className="export-progress">
          <div className="export-progress-bar" style={{ width: `${pct}%` }} />
        </div>
        <span className="export-progress-label">
          Exportando… {state.done}/{state.total}
        </span>
        <button onClick={handleCancel}>Cancelar</button>
      </div>
    );
  }

  return (
    <div className="export-button">
      <button onClick={handleExport}>Exportar capítulo a MP3</button>
      {state.status === 'error' && (
        <span className="export-error" role="alert">
          {state.message}
        </span>
      )}
    </div>
  );
}
