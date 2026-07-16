import { useCallback } from 'react';
import { useDocumentStore } from '../store/document-store';
import { usePlaybackStore } from '../store/playback-store';
import { useThemeStore, ACCENTS } from '../store/theme-store';
import { playerAgent } from '../agents/player';
import '../styles/app-header.css';

/**
 * Header global de Folio (ambas vistas). En el lector muestra el botón
 * "Biblioteca"; en la biblioteca solo el toggle de tema.
 *
 * El regreso a la biblioteca replica la lógica del botón ← de ReaderView sin
 * editar ese componente: consume el estado de historial apilado (history.back()
 * dispara el popstate que ReaderView ya escucha → closeReader) o, si no hay
 * estado de lector, descarga el documento directamente.
 */
export function AppHeader() {
  const doc = useDocumentStore((s) => s.doc);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const accent = useThemeStore((s) => s.accent);
  const setAccent = useThemeStore((s) => s.setAccent);

  const goToLibrary = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.state?.reader) {
      window.history.back();
    } else {
      playerAgent.fullStop();
      usePlaybackStore.getState().stop();
      useDocumentStore.getState().unloadDocument();
    }
  }, []);

  const isDark = theme === 'dark';

  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="app-header__logo" aria-hidden="true">
          f
        </span>
        <span className="app-header__wordmark">
          <span className="app-header__name">Folio</span>
          <span className="app-header__kicker">Audiolector</span>
        </span>
      </div>

      <div className="app-header__actions">
        {doc && (
          <button
            type="button"
            className="pill"
            onClick={goToLibrary}
            title="Volver a la biblioteca"
          >
            Biblioteca
          </button>
        )}
        <button
          type="button"
          className="pill"
          onClick={toggleTheme}
          title={isDark ? 'Cambiar a modo papel' : 'Cambiar a modo noche'}
          aria-label={isDark ? 'Cambiar a modo papel' : 'Cambiar a modo noche'}
        >
          {isDark ? 'Modo papel' : 'Modo noche'}
        </button>
        <div className="accent-picker" role="radiogroup" aria-label="Color de acento">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={accent === a.id}
              className={`accent-swatch${accent === a.id ? ' selected' : ''}`}
              style={{ background: a.swatch }}
              onClick={() => setAccent(a.id)}
              title={a.label}
              aria-label={`Acento ${a.label}`}
            />
          ))}
        </div>
      </div>
    </header>
  );
}
