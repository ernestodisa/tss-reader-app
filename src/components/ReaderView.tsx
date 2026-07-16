import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDocument } from '../hooks/useDocument';
import { usePlayback } from '../hooks/usePlayback';
import { usePlaybackStore } from '../store/playback-store';
import { useDocumentStore } from '../store/document-store';
import { useLibraryStore } from '../store/library-store';
import { useAnnotationsStore } from '../store/annotations-store';
import { playerAgent } from '../agents/player';
import '../styles/reader.css';
import { KaraokeText } from './KaraokeText';
import { ChapterList } from './ChapterList';
import { PlayerBar } from './PlayerBar';
import { ExportButton } from './ExportButton';
import { BookmarkButton } from './BookmarkButton';
import { AnnotationsPanel } from './AnnotationsPanel';

// Virtualización suave: por debajo de este umbral se renderiza el capítulo
// completo (lo normal). Por encima, se renderiza una ventana alrededor del
// scroll con espaciadores de altura estimada arriba/abajo. Sin dependencias.
const VIRTUALIZE_THRESHOLD = 300;
const EST_PARAGRAPH_HEIGHT = 90; // px, estimación gruesa para los espaciadores
const OVERSCAN = 12; // párrafos extra renderizados fuera de viewport a cada lado
const MANUAL_SCROLL_GUARD_MS = 3000; // no forzar auto-scroll si el usuario scrolleó hace <3s
const PROGRAMMATIC_SCROLL_MS = 800; // ventana durante la que el scroll suave se considera nuestro

export function ReaderView() {
  const { doc } = useDocument();
  const { chapterIndex, paragraphIndex } = usePlayback();
  const bookId = useDocumentStore((s) => s.currentBookId);
  const [showChapters, setShowChapters] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const lastManualScrollRef = useRef(0);
  const programmaticUntilRef = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  const chapter = doc?.chapters[chapterIndex];
  const paragraphs = chapter?.paragraphs ?? [];
  const total = paragraphs.length;
  const virtualize = total > VIRTUALIZE_THRESHOLD;

  // Rango de la ventana virtual [start, end). Sin virtualización = capítulo entero.
  const [start, end] = useMemo<[number, number]>(() => {
    if (!virtualize) return [0, total];
    const h = viewportH || 600;
    let s = Math.floor(scrollTop / EST_PARAGRAPH_HEIGHT) - OVERSCAN;
    let e = Math.ceil((scrollTop + h) / EST_PARAGRAPH_HEIGHT) + OVERSCAN;
    s = Math.max(0, s);
    e = Math.min(total, e);
    return [s, e];
  }, [virtualize, scrollTop, viewportH, total]);

  // ── Scroll manual vs programático ────────────────────────────────────────
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (el.clientHeight !== viewportH) setViewportH(el.clientHeight);
    // Si el scroll no lo disparamos nosotros, es del usuario → arma el guard.
    if (Date.now() >= programmaticUntilRef.current) {
      lastManualScrollRef.current = Date.now();
    }
  }, [viewportH]);

  // Mide el viewport al montar / cambiar de doc.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) setViewportH(el.clientHeight);
  }, [doc]);

  // ── Auto-scroll al párrafo activo cuando avanza la reproducción ──────────
  // Guard: si el usuario scrolleó manualmente en los últimos ~3s, no peleamos.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (Date.now() - lastManualScrollRef.current < MANUAL_SCROLL_GUARD_MS) return;

    programmaticUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_MS;

    if (virtualize) {
      // El párrafo activo puede no estar en el DOM; posiciona la ventana por
      // altura estimada para centrarlo, y el render seguirá al nuevo scrollTop.
      const target = paragraphIndex * EST_PARAGRAPH_HEIGHT - el.clientHeight / 2;
      el.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    } else {
      activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    // Solo cuando cambia la POSICIÓN (avance/salto), no en cada palabra.
  }, [chapterIndex, paragraphIndex, virtualize]);

  // Al cambiar de capítulo, reinicia el scroll al inicio y limpia el guard.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      programmaticUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_MS;
      el.scrollTop = 0;
      setScrollTop(0);
    }
    lastManualScrollRef.current = 0;
  }, [chapterIndex]);

  // ── Click en párrafo → posiciona ahí; reproduce solo si estaba sonando ───
  const handleParagraphClick = useCallback(
    (i: number) => {
      const wasPlaying = usePlaybackStore.getState().isPlaying;
      // Corta el audio en curso antes de reposicionar.
      playerAgent.fullStop();
      usePlaybackStore.getState().seekToParagraph(chapterIndex, i);
      // seekToParagraph resetea posición y bumpea generación pero NO toca
      // isPlaying. Reafirmamos la intención: seguir sonando o quedar en pausa.
      if (wasPlaying) usePlaybackStore.getState().play();
      else usePlaybackStore.getState().pause();
    },
    [chapterIndex],
  );

  // ── Click en capítulo (drawer) → salta al párrafo 0 del capítulo ─────────
  const handleChapterSelect = useCallback((idx: number) => {
    const wasPlaying = usePlaybackStore.getState().isPlaying;
    playerAgent.fullStop();
    usePlaybackStore.getState().seekToParagraph(idx, 0);
    if (wasPlaying) usePlaybackStore.getState().play();
    else usePlaybackStore.getState().pause();
    setShowChapters(false);
  }, []);

  // ── Avance por porcentaje (caracteres leídos / totales del libro) ────────
  const percent = useMemo(() => {
    if (!doc || doc.totalCharacters <= 0) return 0;
    let read = 0;
    for (let c = 0; c < chapterIndex; c++) read += doc.chapters[c]?.totalCharacters ?? 0;
    const paras = doc.chapters[chapterIndex]?.paragraphs ?? [];
    for (let p = 0; p < paragraphIndex && p < paras.length; p++) read += paras[p].text.length;
    return Math.min(100, Math.round((read / doc.totalCharacters) * 100));
  }, [doc, chapterIndex, paragraphIndex]);

  // Persiste el progreso de lectura en la biblioteca (lastRead* + updatedAt) para
  // que reabrir el libro y la sincronización entre dispositivos retomen la posición.
  useEffect(() => {
    if (!bookId) return;
    useLibraryStore.getState().updateProgress(bookId, chapterIndex, paragraphIndex, percent);
  }, [bookId, chapterIndex, paragraphIndex, percent]);

  // ── Regreso a la biblioteca ───────────────────────────────────────────────
  const closeReader = useCallback(() => {
    playerAgent.fullStop();
    usePlaybackStore.getState().stop();
    useDocumentStore.getState().unloadDocument();
  }, []);

  // El botón atrás del navegador debe volver a la biblioteca, no salir de la
  // app: al abrir un libro se apila un estado de historial; popstate lo cierra.
  useEffect(() => {
    if (!doc) return;
    window.history.pushState({ reader: true }, '');
    const onPopState = () => closeReader();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [doc, closeReader]);

  // ── Conteo de anotaciones (marcadores + notas) para el botón "Notas · N" ──
  const annotationCount = useAnnotationsStore((s) =>
    bookId
      ? s.bookmarks.filter((b) => b.bookId === bookId).length +
        s.notes.filter((n) => n.bookId === bookId).length
      : 0,
  );

  if (!doc) return null;
  if (!chapter) return <p>Capítulo no encontrado</p>;

  const topSpacer = virtualize ? start * EST_PARAGRAPH_HEIGHT : 0;
  const bottomSpacer = virtualize ? (total - end) * EST_PARAGRAPH_HEIGHT : 0;

  return (
    <div className="reader-view">
      <div className="reader-body">
        <ChapterList
          chapters={doc.chapters}
          currentIndex={chapterIndex}
          open={showChapters}
          onSelect={handleChapterSelect}
          onClose={() => setShowChapters(false)}
        />

        <div className="reader-main">
          <div className="reader-chapter-header">
            <div className="reader-chapter-heading">
              <button
                type="button"
                className="chapter-drawer-toggle"
                onClick={() => setShowChapters((v) => !v)}
                aria-label="Índice de capítulos"
                aria-expanded={showChapters}
                title="Índice de capítulos"
              >
                ☰
              </button>
              <div>
                <div className="reader-chapter-kicker">Capítulo {chapterIndex + 1}</div>
                <h2 className="reader-chapter-title">{chapter.title}</h2>
              </div>
            </div>

            <div className="reader-chapter-actions">
              <span className="reader-progress">
                {percent}% · Cap. {chapterIndex + 1}/{doc.chapters.length} · párr.{' '}
                {paragraphIndex + 1}/{total}
              </span>
              {bookId && <BookmarkButton bookId={bookId} />}
              {bookId && (
                <button
                  type="button"
                  className="reader-notes-btn"
                  onClick={() => setShowAnnotations((v) => !v)}
                  aria-label="Marcadores y notas"
                  aria-expanded={showAnnotations}
                  title="Marcadores y notas"
                >
                  Notas · {annotationCount}
                </button>
              )}
              <ExportButton />
            </div>
          </div>

          <div className="reader-content" ref={scrollRef} onScroll={handleScroll}>
            <div className="reader-column">
              {topSpacer > 0 && <div style={{ height: topSpacer }} aria-hidden="true" />}
              {paragraphs.slice(start, end).map((p, k) => {
                const i = start + k;
                const isActivePar = i === paragraphIndex;
                return (
                  <div
                    key={p.id}
                    ref={isActivePar ? activeRef : undefined}
                    className={`reader-paragraph${isActivePar ? ' active' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-current={isActivePar ? 'true' : undefined}
                    onClick={() => handleParagraphClick(i)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleParagraphClick(i);
                      }
                    }}
                  >
                    {isActivePar ? <KaraokeText paragraph={p} isCurrent /> : p.text}
                  </div>
                );
              })}
              {bottomSpacer > 0 && <div style={{ height: bottomSpacer }} aria-hidden="true" />}
              <p className="reader-hint">
                toca un párrafo para saltar ahí · la lectura continúa sola
              </p>
            </div>
          </div>
        </div>
      </div>

      {showAnnotations && bookId && (
        <>
          <div
            className="annotations-overlay"
            onClick={() => setShowAnnotations(false)}
            aria-hidden="true"
          />
          <AnnotationsPanel bookId={bookId} onClose={() => setShowAnnotations(false)} />
        </>
      )}

      <PlayerBar doc={doc} />
    </div>
  );
}
