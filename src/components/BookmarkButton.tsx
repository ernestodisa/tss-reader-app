import { useCallback } from 'react';
import { usePlaybackStore } from '../store/playback-store';
import { useAnnotationsStore } from '../store/annotations-store';
import { useDocument } from '../hooks/useDocument';

interface BookmarkButtonProps {
  bookId: string;
}

/**
 * Marca/desmarca el párrafo donde está la posición actual de reproducción
 * (chapterIndex/paragraphIndex del playback-store) como bookmark del libro
 * identificado por `bookId`.
 */
export function BookmarkButton({ bookId }: BookmarkButtonProps) {
  const { doc } = useDocument();
  const chapterIndex = usePlaybackStore((s) => s.chapterIndex);
  const paragraphIndex = usePlaybackStore((s) => s.paragraphIndex);
  const hasBookmark = useAnnotationsStore((s) => s.hasBookmark);
  const addBookmark = useAnnotationsStore((s) => s.addBookmark);
  const removeBookmarkAt = useAnnotationsStore((s) => s.removeBookmarkAt);

  // Suscripción reactiva: re-renderiza cuando cambia el arreglo de bookmarks,
  // no solo cuando cambia la posición.
  const marked = useAnnotationsStore((s) =>
    s.bookmarks.some(
      (b) => b.bookId === bookId && b.chapterIndex === chapterIndex && b.paragraphIndex === paragraphIndex,
    ),
  );

  const toggle = useCallback(() => {
    if (!doc) return;
    if (hasBookmark(bookId, chapterIndex, paragraphIndex)) {
      removeBookmarkAt(bookId, chapterIndex, paragraphIndex);
      return;
    }
    const paragraphText =
      doc.chapters[chapterIndex]?.paragraphs[paragraphIndex]?.text ?? '';
    addBookmark(bookId, chapterIndex, paragraphIndex, paragraphText);
  }, [doc, bookId, chapterIndex, paragraphIndex, hasBookmark, addBookmark, removeBookmarkAt]);

  return (
    <button
      type="button"
      className={`bookmark-button${marked ? ' active' : ''}`}
      onClick={toggle}
      aria-pressed={marked}
      aria-label={marked ? 'Quitar marcador de este párrafo' : 'Marcar este párrafo'}
      title={marked ? 'Quitar marcador' : 'Marcar párrafo'}
    >
      {marked ? '★' : '☆'}
    </button>
  );
}
