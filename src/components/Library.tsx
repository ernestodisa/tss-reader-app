import { useLibrary } from '../hooks/useLibrary';

export function Library() {
  const { books, removeBook } = useLibrary();

  if (books.length === 0) {
    return <p className="library-empty">Sin libros en la biblioteca</p>;
  }

  return (
    <div className="library">
      {books.map((book) => (
        <div key={book.id} className="book-card">
          <div className="book-info">
            <h3>{book.title}</h3>
            {book.author && <p>{book.author}</p>}
            <span className="badge">{book.sourceType.toUpperCase()}</span>
            <span className="badge">{book.totalPages || '?'} págs</span>
          </div>
          <button onClick={() => removeBook(book.id)} className="btn-remove">✕</button>
        </div>
      ))}
    </div>
  );
}
