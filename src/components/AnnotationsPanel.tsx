import { useState } from 'react';
import { useAnnotationsStore } from '../store/annotations-store';
import { usePlaybackStore } from '../store/playback-store';
import { useDocument } from '../hooks/useDocument';
import { playerAgent } from '../agents/player';

interface AnnotationsPanelProps {
  bookId: string;
  onClose: () => void;
}

/**
 * Panel toggleable con marcadores y notas del libro actual. Click en un ítem
 * reposiciona la reproducción ahí (mismo patrón que ChapterList: corta audio,
 * reposiciona, y respeta si estaba sonando o pausado). Permite agregar una
 * nota a la posición actual desde un textarea inline.
 */
export function AnnotationsPanel({ bookId, onClose }: AnnotationsPanelProps) {
  const { doc } = useDocument();
  const bookmarks = useAnnotationsStore((s) => s.listBookmarks(bookId));
  const notes = useAnnotationsStore((s) => s.listNotes(bookId));
  const removeBookmark = useAnnotationsStore((s) => s.removeBookmark);
  const removeNote = useAnnotationsStore((s) => s.removeNote);
  const addNote = useAnnotationsStore((s) => s.addNote);

  const [draftNote, setDraftNote] = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);

  const seekTo = (chapterIndex: number, paragraphIndex: number) => {
    const wasPlaying = usePlaybackStore.getState().isPlaying;
    playerAgent.fullStop();
    usePlaybackStore.getState().seekToParagraph(chapterIndex, paragraphIndex);
    if (wasPlaying) usePlaybackStore.getState().play();
    else usePlaybackStore.getState().pause();
  };

  const chapterTitle = (chapterIndex: number) =>
    doc?.chapters[chapterIndex]?.title ?? `Capítulo ${chapterIndex + 1}`;

  const handleAddNote = () => {
    const text = draftNote.trim();
    if (!text) return;
    const { chapterIndex, paragraphIndex } = usePlaybackStore.getState();
    const paragraphText =
      doc?.chapters[chapterIndex]?.paragraphs[paragraphIndex]?.text ?? '';
    addNote(bookId, chapterIndex, paragraphIndex, paragraphText, text);
    setDraftNote('');
    setShowNoteInput(false);
  };

  return (
    <div className="annotations-panel">
      <div className="annotations-panel-header">
        <h3>Marcadores y notas</h3>
        <button
          type="button"
          className="annotations-panel-close"
          onClick={onClose}
          aria-label="Cerrar panel de marcadores y notas"
        >
          ✕
        </button>
      </div>

      <section className="annotations-section">
        <h4>Marcadores</h4>
        {bookmarks.length === 0 && <p className="annotations-empty">Sin marcadores todavía.</p>}
        <ul className="annotations-list">
          {bookmarks.map((b) => (
            <li key={b.id} className="annotations-item">
              <button
                type="button"
                className="annotations-item-body"
                onClick={() => seekTo(b.chapterIndex, b.paragraphIndex)}
              >
                <span className="annotations-item-chapter">★ {chapterTitle(b.chapterIndex)}</span>
                <span className="annotations-item-excerpt">{b.excerpt}</span>
              </button>
              <button
                type="button"
                className="annotations-item-remove"
                onClick={() => removeBookmark(b.id)}
                aria-label="Borrar marcador"
                title="Borrar marcador"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="annotations-section">
        <div className="annotations-section-header">
          <h4>Notas</h4>
          <button
            type="button"
            className="annotations-add-note-toggle"
            onClick={() => setShowNoteInput((v) => !v)}
          >
            {showNoteInput ? 'Cancelar' : '+ Nota en posición actual'}
          </button>
        </div>

        {showNoteInput && (
          <div className="annotations-note-input">
            <textarea
              value={draftNote}
              onChange={(e) => setDraftNote(e.target.value)}
              placeholder="Escribe tu nota…"
              rows={3}
              autoFocus
            />
            <button type="button" onClick={handleAddNote} disabled={!draftNote.trim()}>
              Guardar
            </button>
          </div>
        )}

        {notes.length === 0 && <p className="annotations-empty">Sin notas todavía.</p>}
        <ul className="annotations-list">
          {notes.map((n) => (
            <li key={n.id} className="annotations-item annotations-item-note">
              <button
                type="button"
                className="annotations-item-body"
                onClick={() => seekTo(n.chapterIndex, n.paragraphIndex)}
              >
                <span className="annotations-item-chapter">{chapterTitle(n.chapterIndex)}</span>
                <span className="annotations-item-excerpt">«{n.excerpt}»</span>
                <span className="annotations-item-note-text">{n.text}</span>
              </button>
              <button
                type="button"
                className="annotations-item-remove"
                onClick={() => removeNote(n.id)}
                aria-label="Borrar nota"
                title="Borrar nota"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
