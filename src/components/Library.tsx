import { useState, useCallback, useMemo } from 'react';
import { useLibrary } from '../hooks/useLibrary';
import { useLibraryStore } from '../store/library-store';
import type { LibraryEntry } from '../store/library-store';
import { useDocumentStore } from '../store/document-store';
import { usePlaybackStore } from '../store/playback-store';
import { loadDoc, deleteDoc } from '../lib/library-docs';
import { SyncPanel } from './SyncPanel';
import { ImportDropzone } from './ImportDropzone';
import '../styles/library.css';

/** Duración estimada en segundos a partir de caracteres (heurística: ~15 caracteres/segundo hablado). */
function estimateSeconds(totalCharacters: number): number {
  return totalCharacters / 15;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function progressInfo(book: LibraryEntry): { pct: number; label: string } {
  if (book.lastReadChapter == null) {
    return { pct: 2, label: 'Nuevo' };
  }
  // % real por caracteres (lo persiste ReaderView); barra con mínimo visible 2%.
  const pct = Math.max(2, Math.min(100, book.lastReadPercent ?? 2));
  return { pct, label: `${book.lastReadPercent ?? 0}% · Cap. ${book.lastReadChapter + 1}` };
}

export function Library() {
  const { books, removeBook } = useLibrary();
  const [openError, setOpenError] = useState<string | null>(null);

  const totalSeconds = useMemo(
    () => books.reduce((sum, b) => sum + estimateSeconds(b.totalCharacters), 0),
    [books],
  );

  const handleOpen = useCallback(async (id: string) => {
    setOpenError(null);
    try {
      const doc = await loadDoc(id);
      if (!doc) {
        setOpenError('No se encontró el contenido guardado de este libro. Vuelve a importar el archivo.');
        return;
      }
      useDocumentStore.setState({ doc, isLoading: false, error: null, currentBookId: id });
      const book = useLibraryStore.getState().books.find((b) => b.id === id);
      if (book && book.lastReadChapter != null && book.lastReadParagraph != null) {
        // B2: clampa los índices restaurados contra el doc REAL antes de aplicarlos.
        // Un libro re-extraído (parser nuevo, menos capítulos/párrafos) puede tener
        // guardado un índice fuera de rango → hacer seek ahí rompería la lectura.
        const ci = Math.max(0, Math.min(book.lastReadChapter, doc.chapters.length - 1));
        const chapter = doc.chapters[ci];
        const pi = chapter
          ? Math.max(0, Math.min(book.lastReadParagraph, chapter.paragraphs.length - 1))
          : 0;
        usePlaybackStore.getState().seekToParagraph(ci, pi);
      }
    } catch (err) {
      console.error('Error al abrir el libro', err);
      setOpenError('Error al abrir el libro guardado.');
    }
  }, []);

  const handleRemove = useCallback((id: string) => {
    removeBook(id);
    deleteDoc(id).catch((err) => console.error('Error al borrar el documento persistido', err));
  }, [removeBook]);

  return (
    <div className="lib-view">
      <div className="lib-head">
        <div className="lib-head__titles">
          <span className="lib-kicker">Continúa escuchando</span>
          <h1 className="lib-title">Tu biblioteca</h1>
        </div>
        <span className="lib-stats">
          {books.length} libro{books.length === 1 ? '' : 's'} · {formatDuration(totalSeconds)} escuchadas
        </span>
      </div>

      <ImportDropzone />

      <SyncPanel />

      {openError && <p className="lib-dropzone__error">{openError}</p>}

      {books.length === 0 ? (
        <p className="lib-empty">Sin libros en la biblioteca</p>
      ) : (
        <div className="lib-list">
          {books.map((book) => {
            const { pct, label } = progressInfo(book);
            const meta = [book.author, book.sourceType.toUpperCase(), formatDuration(estimateSeconds(book.totalCharacters))]
              .filter(Boolean)
              .join(' · ');
            return (
              <div
                key={book.id}
                className="lib-card"
                role="button"
                tabIndex={0}
                onClick={() => handleOpen(book.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpen(book.id); } }}
              >
                <div className="lib-card__cover">
                  {book.coverDataUrl ? (
                    <img src={book.coverDataUrl} alt="" />
                  ) : (
                    <div className="lib-card__cover-fallback">
                      {book.title.trim().charAt(0).toUpperCase() || '?'}
                    </div>
                  )}
                </div>
                <div className="lib-card__body">
                  <h3 className="lib-card__title">{book.title}</h3>
                  <span className="lib-card__meta">{meta}</span>
                </div>
                <div className="lib-card__progress">
                  <div className="lib-card__progress-row">
                    <span className="lib-card__progress-label">{label}</span>
                    <span className="lib-card__continue">Continuar ›</span>
                  </div>
                  <div className="lib-card__bar">
                    <div className="lib-card__bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleRemove(book.id); }}
                  className="lib-card__remove"
                  aria-label="Eliminar de la biblioteca"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

