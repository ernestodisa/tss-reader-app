import { useState, useCallback } from 'react';
import { useDocument } from '../hooks/useDocument';
import { useLibrary } from '../hooks/useLibrary';
import { useDocumentStore } from '../store/document-store';
import { saveDoc } from '../lib/library-docs';
import '../styles/library.css';

export function ImportDropzone() {
  const { loadDocument, isLoading, error } = useDocument();
  const { addBook } = useLibrary();
  const [dragActive, setDragActive] = useState(false);

  const handleFile = useCallback(async (file: File) => {
    const success = await loadDocument(file);
    if (success) {
      // The doc is now in the store — add it to library
      const doc = useDocumentStore.getState().doc;
      if (doc) {
        const id = addBook(doc);
        useDocumentStore.getState().setCurrentBookId(id);
        try {
          await saveDoc(id, doc);
        } catch (err) {
          console.error('No se pudo persistir el documento en la biblioteca', err);
        }
      }
    }
  }, [loadDocument, addBook]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div
      className={`lib-dropzone ${dragActive ? 'active' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragLeave={() => setDragActive(false)}
      onDrop={onDrop}
    >
      <input
        type="file"
        accept=".pdf,.epub,application/pdf,application/epub+zip"
        onChange={onChange}
        style={{ display: 'none' }}
        id="file-input"
      />
      <label htmlFor="file-input" className="lib-dropzone__circle" aria-hidden="true">
        +
      </label>
      <label htmlFor="file-input" className="lib-dropzone__copy">
        <span className="lib-dropzone__title">
          {isLoading ? 'Procesando…' : 'Arrastra un PDF o ePub'}
        </span>
        <span className="lib-dropzone__subtitle">
          se convierte en audiolibro al instante · portada y capítulos se extraen solos
        </span>
      </label>
      {error && <p className="lib-dropzone__error">{error}</p>}
    </div>
  );
}
