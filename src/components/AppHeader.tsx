import { useCallback, useEffect, useRef, useState } from 'react';
import { useDocumentStore } from '../store/document-store';
import { usePlaybackStore } from '../store/playback-store';
import { useThemeStore, ACCENTS } from '../store/theme-store';
import { useAnnotationsStore } from '../store/annotations-store';
import { playerAgent } from '../agents/player';
import { BookmarkButton } from './BookmarkButton';
import { ExportButton } from './ExportButton';
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
  const fontScale = useThemeStore((s) => s.fontScale);
  const fontBigger = useThemeStore((s) => s.fontBigger);
  const fontSmaller = useThemeStore((s) => s.fontSmaller);
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const bookId = useDocumentStore((s) => s.currentBookId);
  const toggleAnnotations = useDocumentStore((s) => s.toggleAnnotations);
  const annotationCount = useAnnotationsStore((s) =>
    bookId
      ? s.bookmarks.filter((b) => b.bookId === bookId).length +
        s.notes.filter((n) => n.bookId === bookId).length
      : 0,
  );

  // Cierra los menús (apariencia / acciones) al hacer click fuera.
  useEffect(() => {
    if (!menuOpen && !actionsOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (menuOpen && menuRef.current && !menuRef.current.contains(t)) setMenuOpen(false);
      if (actionsOpen && actionsRef.current && !actionsRef.current.contains(t)) setActionsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [menuOpen, actionsOpen]);

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
            className="pill app-header__lib"
            onClick={goToLibrary}
            title="Volver a la biblioteca"
            aria-label="Volver a la biblioteca"
          >
            {/* Icono libro (SVG inline: los glifos tipo 📚 salen como emoji azul en iOS) */}
            <svg className="app-header__lib-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span className="app-header__lib-label">Biblioteca</span>
          </button>
        )}

        {/* Acciones del libro (Marcar / Notas / Exportar) — solo con libro abierto. */}
        {doc && bookId && (
          <div className="appearance" ref={actionsRef}>
            <button
              type="button"
              className="pill appearance__toggle"
              onClick={() => setActionsOpen((v) => !v)}
              aria-expanded={actionsOpen}
              aria-haspopup="menu"
              title="Marcar, notas y exportar"
              aria-label="Marcar, notas y exportar"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              {annotationCount > 0 && <span className="actions-count">{annotationCount}</span>}
            </button>
            {actionsOpen && (
              <div className="appearance__menu" role="menu">
                <BookmarkButton bookId={bookId} />
                <button
                  type="button"
                  className="pill appearance__row"
                  onClick={() => {
                    toggleAnnotations();
                    setActionsOpen(false);
                  }}
                >
                  Notas · {annotationCount}
                </button>
                <ExportButton />
              </div>
            )}
          </div>
        )}

        {/* Apariencia: pill "Aa" que despliega tema + acentos + tamaño de fuente.
            En desktop muestra la etiqueta; en móvil queda como icono compacto. */}
        <div className="appearance" ref={menuRef}>
          <button
            type="button"
            className="pill appearance__toggle"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            title="Apariencia"
          >
            Aa
          </button>
          {menuOpen && (
            <div className="appearance__menu" role="menu">
              <button type="button" className="pill appearance__row" onClick={toggleTheme}>
                {isDark ? '☼ Modo papel' : '☾ Modo noche'}
              </button>
              <div className="appearance__section">Acento</div>
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
              <div className="appearance__section">Tamaño de letra</div>
              <div className="appearance__font-row">
                <button type="button" className="pill" onClick={fontSmaller} aria-label="Letra más chica">
                  A−
                </button>
                <span className="appearance__font-value">{Math.round(fontScale * 100)}%</span>
                <button type="button" className="pill" onClick={fontBigger} aria-label="Letra más grande">
                  A+
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
