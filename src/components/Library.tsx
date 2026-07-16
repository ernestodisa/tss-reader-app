import { useState, useCallback } from 'react';
import { useLibrary } from '../hooks/useLibrary';
import { useLibraryStore } from '../store/library-store';
import { useDocumentStore } from '../store/document-store';
import { usePlaybackStore } from '../store/playback-store';
import { loadDoc, deleteDoc } from '../lib/library-docs';

export function Library() {
  const { books, removeBook } = useLibrary();
  const [openError, setOpenError] = useState<string | null>(null);

  const handleOpen = useCallback(async (id: string) => {
    setOpenError(null);
    try {
      const doc = await loadDoc(id);
      if (!doc) {
        setOpenError('No se encontró el contenido guardado de este libro. Vuelve a importar el archivo.');
        return;
      }
      useDocumentStore.setState({ doc, isLoading: false, error: null });
      const book = useLibraryStore.getState().books.find((b) => b.id === id);
      if (book && book.lastReadChapter != null && book.lastReadParagraph != null) {
        usePlaybackStore.getState().seekToParagraph(book.lastReadChapter, book.lastReadParagraph);
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

  if (books.length === 0) {
    return <p className="library-empty">Sin libros en la biblioteca</p>;
  }

  return (
    <div className="library">
      {openError && <p className="error">{openError}</p>}
      {books.map((book) => (
        <div
          key={book.id}
          className="book-card"
          role="button"
          tabIndex={0}
          onClick={() => handleOpen(book.id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpen(book.id); } }}
        >
          <div className="book-info">
            <h3>{book.title}</h3>
            {book.author && <p>{book.author}</p>}
            <span className="badge">{book.sourceType.toUpperCase()}</span>
            <span className="badge">{book.totalPages || '?'} págs</span>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); handleRemove(book.id); }}
            className="btn-remove"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
