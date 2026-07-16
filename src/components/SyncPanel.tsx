import { useState, useCallback } from 'react';
import { useLibraryStore } from '../store/library-store';
import { generateSyncCode, pushProgress, pullProgress } from '../lib/sync-client';

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

  // Estilos con scope propio: SyncPanel es un componente nuevo y global.css
  // (ajeno) no fue tocado — se evita depender de clases que no existen ahí.
  return (
    <div
      className="sync-panel"
      style={{
        background: 'var(--bg-surface)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow)',
        marginBottom: '0.5rem',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          width: '100%',
          textAlign: 'left',
          background: 'none',
          border: 'none',
          padding: '0.75rem 1rem',
          cursor: 'pointer',
          color: 'var(--text)',
          font: 'inherit',
        }}
      >
        {expanded ? '▾' : '▸'} Sincronizar entre dispositivos
      </button>
      {expanded && (
        <div style={{ padding: '0 1rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', margin: 0 }}>
            Genera un código en un dispositivo y úsalo en otro para compartir tu progreso de lectura.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="CÓDIGO"
              maxLength={32}
              style={{
                flex: '1 1 8rem',
                padding: '0.375rem 0.5rem',
                borderRadius: 4,
                border: '1px solid var(--bg-elevated)',
                background: 'var(--bg-elevated)',
                color: 'var(--text)',
                fontFamily: 'monospace',
                letterSpacing: '0.05em',
              }}
            />
            <button type="button" onClick={handleGenerate} disabled={busy}>
              Generar
            </button>
            <button type="button" onClick={handleCopy} disabled={busy || !code}>
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" onClick={handlePush} disabled={busy}>
              Subir progreso
            </button>
            <button type="button" onClick={handlePull} disabled={busy}>
              Bajar progreso
            </button>
          </div>
          {status && (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', margin: 0 }}>{status}</p>
          )}
        </div>
      )}
    </div>
  );
}
