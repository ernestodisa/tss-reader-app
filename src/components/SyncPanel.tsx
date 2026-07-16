import { useState, useCallback } from 'react';
import { useLibraryStore } from '../store/library-store';
import { generateSyncCode, pushProgress, pullProgress } from '../lib/sync-client';
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
    setBusy(true);
    setStatus(null);
    const books = useLibraryStore.getState().books;
    const result = await pushProgress(code.trim(), { books, syncedAt: Date.now() });
    setBusy(false);
    setStatus(
      result.success
        ? `Progreso subido (${books.length} libro${books.length === 1 ? '' : 's'}).`
        : `Error al subir: ${result.error.message}`,
    );
  }, [code]);

  const handlePull = useCallback(async () => {
    if (!code.trim()) {
      setStatus('Escribe el código con el que quieres conectar.');
      return;
    }
    setBusy(true);
    setStatus(null);
    const result = await pullProgress(code.trim());
    setBusy(false);
    if (!result.success) {
      setStatus(`Error al bajar: ${result.error.message}`);
      return;
    }
    useLibraryStore.getState().mergeBooks(result.data.books);
    setStatus(`Progreso bajado y combinado (${result.data.books.length} libro${result.data.books.length === 1 ? '' : 's'}).`);
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
            Genera un código en un dispositivo y úsalo en otro para compartir tu progreso de lectura.
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
