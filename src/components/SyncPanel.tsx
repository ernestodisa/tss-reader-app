import { useState, useCallback } from 'react';
import { useLibraryStore } from '../store/library-store';
import { generateSyncCode, pushProgress, pullProgress, pushBook, pullBook } from '../lib/sync-client';
import { loadDoc, saveDoc } from '../lib/library-docs';
import '../styles/library.css';

/**
 * Panel de sincronización manual entre dispositivos, identificado por un
 * código legible. Sin auto-sync: el usuario decide cuándo Subir/Bajar.
 */
export function SyncPanel() {
  const [expanded, setExpanded] = useState(false);
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleGenerate = useCallback(() => {
    const newCode = generateSyncCode();
    setCode(newCode);
    setStatus(`Código generado: ${newCode}`);
    setCopied(false);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setStatus('No se pudo copiar. Cópialo manualmente.');
    }
  }, [code]);

  const handlePush = useCallback(async () => {
    if (!code.trim()) {
      setStatus('Genera o escribe un código primero.');
      return;
    }
    const syncCode = code.trim();
    setBusy(true);
    setStatus(null);
    const books = useLibraryStore.getState().books;
    const result = await pushProgress(syncCode, { books, syncedAt: Date.now() });
    if (!result.success) {
      setBusy(false);
      setStatus(`Error al subir: ${result.error.message}`);
      return;
    }
    // Sube también el CONTENIDO de cada libro (secuencial, con progreso visible).
    let uploaded = 0;
    let failed = 0;
    for (let i = 0; i < books.length; i++) {
      setStatus(`Subiendo libros… ${i + 1}/${books.length}`);
      const doc = await loadDoc(books[i].id);
      if (!doc) continue; // entrada sin contenido local (p.ej. bajada solo como progreso)
      const bookResult = await pushBook(syncCode, books[i].id, doc);
      if (bookResult.success) uploaded++;
      else failed++;
    }
    setBusy(false);
    setStatus(
      `Progreso y ${uploaded} libro${uploaded === 1 ? '' : 's'} subidos.` +
        (failed > 0 ? ` ${failed} fallaron (reintenta).` : ''),
    );
  }, [code]);

  const handlePull = useCallback(async () => {
    if (!code.trim()) {
      setStatus('Escribe el código con el que quieres conectar.');
      return;
    }
    const syncCode = code.trim();
    setBusy(true);
    setStatus(null);
    const result = await pullProgress(syncCode);
    if (!result.success) {
      setBusy(false);
      setStatus(`Error al bajar: ${result.error.message}`);
      return;
    }
    useLibraryStore.getState().mergeBooks(result.data.books);
    // Baja el contenido de los libros que este dispositivo no tiene localmente.
    const merged = useLibraryStore.getState().books;
    let downloaded = 0;
    let missing = 0;
    for (let i = 0; i < merged.length; i++) {
      const existing = await loadDoc(merged[i].id);
      if (existing) continue;
      setStatus(`Bajando libros… ${downloaded + 1}`);
      const bookResult = await pullBook(syncCode, merged[i].id);
      if (bookResult.success) {
        await saveDoc(merged[i].id, bookResult.data);
        downloaded++;
      } else {
        missing++;
      }
    }
    setBusy(false);
    setStatus(
      `Progreso combinado (${result.data.books.length} entradas)` +
        (downloaded > 0 ? ` · ${downloaded} libro${downloaded === 1 ? '' : 's'} descargado${downloaded === 1 ? '' : 's'}` : '') +
        (missing > 0 ? ` · ${missing} sin contenido en la nube (súbelos desde el otro dispositivo)` : '') +
        '.',
    );
  }, [code]);

  return (
    <div className="lib-sync">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="lib-sync__toggle"
      >
        <span className="lib-sync__chevron">{expanded ? '▾' : '▸'}</span>
        <span className="lib-sync__toggle-label">Sincronizar entre dispositivos</span>
        {status && !expanded && <span className="lib-sync__last">último: {status}</span>}
      </button>
      {expanded && (
        <div className="lib-sync__body">
          <p className="lib-sync__desc">
            Tu biblioteca y tu progreso ya se sincronizan solos con tu cuenta en cada
            dispositivo donde inicies sesión. Este código es solo para compartir con
            <em> otra</em> cuenta o mover tu biblioteca fuera de tu sesión.
          </p>
          <p className="lib-sync__desc">
            Genera un código en un dispositivo y úsalo en otro para compartir tus libros y tu progreso de lectura.
          </p>
          <div className="lib-sync__row">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="CÓDIGO"
              maxLength={32}
              className="lib-sync__code"
            />
            <button type="button" onClick={handleGenerate} disabled={busy} className="pill">
              Generar
            </button>
            <button type="button" onClick={handleCopy} disabled={busy || !code} className="pill">
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          </div>
          <div className="lib-sync__row">
            <button type="button" onClick={handlePush} disabled={busy} className="pill pill-solid">
              ↑ Subir progreso
            </button>
            <button type="button" onClick={handlePull} disabled={busy} className="pill">
              ↓ Bajar progreso
            </button>
            <span className="lib-sync__spacer" />
          </div>
          {status && <p className="lib-sync__status">{status}</p>}
        </div>
      )}
    </div>
  );
}
