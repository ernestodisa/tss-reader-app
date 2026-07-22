import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDocument } from '../hooks/useDocument';
import { usePlayback } from '../hooks/usePlayback';
import { usePlaybackStore } from '../store/playback-store';
import { useDocumentStore } from '../store/document-store';
import { useLibraryStore } from '../store/library-store';
import { playerAgent } from '../agents/player';
import '../styles/reader.css';
import { KaraokeText } from './KaraokeText';
import { ChapterList } from './ChapterList';
import { PlayerBar } from './PlayerBar';
import { AnnotationsPanel } from './AnnotationsPanel';
import { OfflineDownloadButton } from './OfflineDownloadButton';
import { IconReturn } from './icons';

// Virtualización suave: por debajo de este umbral se renderiza el capítulo
// completo (lo normal). Por encima, se renderiza una ventana alrededor del
// scroll con espaciadores de altura estimada arriba/abajo. Sin dependencias.
const VIRTUALIZE_THRESHOLD = 300;
const EST_PARAGRAPH_HEIGHT = 90; // px, estimación gruesa para los espaciadores
const OVERSCAN = 12; // párrafos extra renderizados fuera de viewport a cada lado
const MANUAL_SCROLL_GUARD_MS = 3000; // no forzar auto-scroll si el usuario scrolleó hace <3s
// A12/M13: clasificación de scroll por POSICIÓN DESTINO, no por timer. Un scroll
// suave no tiene duración acotada, así que en vez de una "ventana de N ms" se
// sigue la distancia al destino: mientras disminuye (o queda ≤ epsilon) es
// nuestro; si aumenta, el usuario metió mano. SAFETY = tope por si el suave nunca
// llega (viewport cambió, animación cancelada). CORRECTION_MIN_PX = umbral para
// el segundo ajuste con rect real en virtualizado.
const PROGRAMMATIC_EPSILON = 4; // px de holgura de llegada
const PROGRAMMATIC_SAFETY_MS = 3000; // limpia el tracking si el destino nunca se alcanza
const CORRECTION_MIN_PX = 24; // px: recentrado post-scroll solo si está más descentrado que esto

export function ReaderView() {
  const { doc } = useDocument();
  const { chapterIndex, paragraphIndex } = usePlayback();
  const bookId = useDocumentStore((s) => s.currentBookId);
  const [showChapters, setShowChapters] = useState(false);
  const showAnnotations = useDocumentStore((s) => s.showAnnotations);

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const lastManualScrollRef = useRef(0);
  // A12/M13: seguimiento del scroll programático en vuelo. targetRef = destino
  // esperado (null si no hay ninguno); lastDistRef = última distancia medida
  // (para clasificar acercamiento vs alejamiento); isCorrectionRef = si el scroll
  // en curso es ya el segundo ajuste (para no re-corregir en bucle); safetyRef =
  // timeout de seguridad que suelta el ref si el suave nunca llega.
  const programmaticTargetRef = useRef<number | null>(null);
  const programmaticLastDistRef = useRef(0);
  const programmaticIsCorrectionRef = useRef(false);
  const programmaticSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const correctRetryRef = useRef(false);
  // M12: distinguir navegación EXPLÍCITA de capítulo (bumpea generación) del
  // AUTO-AVANCE gapless (no la bumpea), sin estado global nuevo — comparando la
  // generación actual contra la vista en el último cambio de capítulo.
  const generationId = usePlaybackStore((s) => s.generationId);
  const prevGenRef = useRef(generationId);
  const prevChapterRef = useRef(chapterIndex);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  // "Despegado": el usuario scrolleó y la PALABRA activa del karaoke quedó fuera
  // de pantalla. Mientras dure, el auto-scroll no pelea y se muestra un botón
  // temporal para volver a la lectura en voz.
  const [detached, setDetached] = useState(false);

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

  // ── Scroll programático: armado / limpieza del tracking ──────────────────
  const clearProgrammatic = useCallback(() => {
    programmaticTargetRef.current = null;
    if (programmaticSafetyRef.current) {
      clearTimeout(programmaticSafetyRef.current);
      programmaticSafetyRef.current = null;
    }
  }, []);

  // Arma el seguimiento de un scroll programático hacia `targetTop`. Desde aquí
  // y hasta llegar (≤ epsilon) o hasta que el usuario interrumpa, el listener de
  // scroll NO arma el guard manual ni evalúa despegue. `isCorrection` marca el
  // segundo ajuste (rect real) para que su llegada no dispare otra corrección.
  const armProgrammatic = useCallback((targetTop: number, isCorrection: boolean) => {
    const el = scrollRef.current;
    programmaticTargetRef.current = targetTop;
    programmaticLastDistRef.current = Math.abs((el?.scrollTop ?? 0) - targetTop);
    programmaticIsCorrectionRef.current = isCorrection;
    if (programmaticSafetyRef.current) clearTimeout(programmaticSafetyRef.current);
    programmaticSafetyRef.current = setTimeout(() => {
      // El suave nunca llegó (viewport cambió, animación cancelada): suelta el
      // ref para no ignorar los scrolls del usuario indefinidamente.
      programmaticTargetRef.current = null;
      programmaticSafetyRef.current = null;
    }, PROGRAMMATIC_SAFETY_MS);
  }, []);

  // A13: ¿la PALABRA activa (misma geometría que el seguimiento fino) está
  // visible en el contenedor con un margen razonable? Sin palabra montada, cae
  // al rect del párrafo. Así, perder de vista la palabra dentro de un párrafo
  // gigante SÍ despega (antes el párrafo "seguía visible" y no había escape).
  const isActiveVisible = useCallback((): boolean => {
    const el = scrollRef.current;
    if (!el) return true;
    if (virtualize && (paragraphIndex < start || paragraphIndex >= end)) return false;
    const word = el.querySelector<HTMLElement>('.karaoke-text .kw-current');
    const node = word ?? activeRef.current;
    if (!node) return false;
    const c = el.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const margin = Math.min(40, c.height * 0.08);
    return r.bottom > c.top + margin && r.top < c.bottom - margin;
  }, [virtualize, paragraphIndex, start, end]);

  // Mide el viewport al montar / cambiar de doc.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) setViewportH(el.clientHeight);
  }, [doc]);

  // ── Auto-scroll al párrafo activo cuando avanza la reproducción ──────────
  // Calcula el destino (rect REAL si el párrafo está montado; estimación por
  // altura en virtualizado si no), lo registra como programático y hace scroll
  // suave. Guard: si el usuario scrolleó hace <3s, no peleamos.
  const scrollToActive = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const node =
      virtualize && (paragraphIndex < start || paragraphIndex >= end)
        ? null
        : activeRef.current;
    let target: number;
    if (node) {
      const c = el.getBoundingClientRect();
      const r = node.getBoundingClientRect();
      const desired = c.height / 2 - r.height / 2; // centrar el párrafo
      target = el.scrollTop + (r.top - c.top) - desired;
    } else if (virtualize) {
      // Párrafo activo fuera de la ventana renderizada → destino ESTIMADO; el
      // render seguirá al nuevo scrollTop y luego se corrige con el rect real.
      target = paragraphIndex * EST_PARAGRAPH_HEIGHT - el.clientHeight / 2;
    } else {
      return; // no virtualizado y sin nodo: nada que centrar
    }
    target = Math.max(0, target);
    if (Math.abs(el.scrollTop - target) <= PROGRAMMATIC_EPSILON) return; // ya está
    armProgrammatic(target, false);
    el.scrollTo({ top: target, behavior: 'smooth' });
  }, [virtualize, paragraphIndex, start, end, armProgrammatic]);

  // A12: tras completar un scroll programático ESTIMADO (virtualizado), corrige
  // con el rect REAL del párrafo ya montado — en vez de evaluar despegue con un
  // destino aproximado que pudo dejar el párrafo fuera de pantalla.
  const correctAfterProgrammatic = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !virtualize) return;
    const node = activeRef.current;
    if (!node) {
      // El párrafo activo aún no está montado tras el scroll estimado: un único
      // reintento de scrollToActive (correctRetryRef evita el bucle).
      if (correctRetryRef.current) { correctRetryRef.current = false; return; }
      correctRetryRef.current = true;
      scrollToActive();
      return;
    }
    correctRetryRef.current = false;
    const c = el.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const desired = c.height / 2 - r.height / 2;
    const delta = (r.top - c.top) - desired;
    if (Math.abs(delta) < CORRECTION_MIN_PX) return; // ya centrado
    const target = Math.max(0, el.scrollTop + delta);
    if (Math.abs(el.scrollTop - target) <= PROGRAMMATIC_EPSILON) return;
    armProgrammatic(target, true);
    el.scrollTo({ top: target, behavior: 'smooth' });
  }, [virtualize, scrollToActive, armProgrammatic]);

  // ── Scroll manual vs programático (clasificación por posición destino) ────
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    setScrollTop(top);
    if (el.clientHeight !== viewportH) setViewportH(el.clientHeight);

    if (programmaticTargetRef.current !== null) {
      const target = programmaticTargetRef.current;
      const dist = Math.abs(top - target);
      if (dist <= PROGRAMMATIC_EPSILON) {
        // Llegó: fin del scroll programático.
        const wasCorrection = programmaticIsCorrectionRef.current;
        clearProgrammatic();
        // A12: si NO era ya una corrección, en virtualizado reajusta con el rect
        // real (tras el commit del render → requestAnimationFrame).
        if (!wasCorrection && virtualize) {
          requestAnimationFrame(() => correctAfterProgrammatic());
        }
        return;
      }
      if (dist <= programmaticLastDistRef.current + PROGRAMMATIC_EPSILON) {
        // Sigue acercándose (o meseta dentro de epsilon): es nuestro scroll en
        // tránsito → no armar guard ni evaluar despegue.
        programmaticLastDistRef.current = dist;
        return;
      }
      // M13: la distancia AUMENTÓ → el usuario metió mano a media animación. Se
      // respeta como scroll de usuario y se cancela el tracking programático.
      clearProgrammatic();
    }
    // Scroll del usuario: arma el guard y evalúa si nos "despegó" de la lectura.
    lastManualScrollRef.current = Date.now();
    setDetached(!isActiveVisible());
  }, [viewportH, isActiveVisible, virtualize, clearProgrammatic, correctAfterProgrammatic]);

  useEffect(() => {
    if (!scrollRef.current) return;
    // Despegado: el usuario se fue a otra parte del texto a propósito. No
    // peleamos — el botón "volver a la lectura" es el camino de regreso.
    if (detached) return;
    if (Date.now() - lastManualScrollRef.current < MANUAL_SCROLL_GUARD_MS) return;
    scrollToActive();
    // Solo cuando cambia la POSICIÓN (avance/salto), no en cada palabra.
  }, [chapterIndex, paragraphIndex, detached, scrollToActive]);

  // Botón temporal "volver a la lectura": re-engancha el seguimiento. Con la
  // corrección A12 (rect real en virtualizado), al completar el scroll la
  // palabra activa queda visible → no vuelve a despegarse solo.
  const handleReturnToReading = useCallback(() => {
    setDetached(false);
    lastManualScrollRef.current = 0;
    scrollToActive();
  }, [scrollToActive]);

  // ── Seguimiento FINO dentro de párrafos largos ────────────────────────────
  // El auto-scroll por párrafo centra el párrafo una vez; en párrafos que no
  // caben en pantalla la palabra del karaoke se salía de vista. Aquí el punto
  // de seguimiento es la PALABRA activa: cuando el resaltado sale de la banda
  // cómoda del viewport (25%–70%), se re-centra con scroll suave. Respeta el
  // guard de scroll manual y hace no-op mientras `detached` (A13).
  const wordIndex = usePlaybackStore((s) => s.wordIndex);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || detached) return;
    if (Date.now() - lastManualScrollRef.current < MANUAL_SCROLL_GUARD_MS) return;
    const word = el.querySelector<HTMLElement>('.karaoke-text .kw-current');
    if (!word) return;
    const c = el.getBoundingClientRect();
    const r = word.getBoundingClientRect();
    const topBand = c.top + c.height * 0.25;
    const bottomBand = c.top + c.height * 0.7;
    if (r.top >= topBand && r.bottom <= bottomBand) return; // en banda: no tocar
    const target = Math.max(0, el.scrollTop + (r.top - c.top) - c.height * 0.4);
    if (Math.abs(el.scrollTop - target) <= PROGRAMMATIC_EPSILON) return;
    armProgrammatic(target, false);
    el.scrollTo({ top: target, behavior: 'smooth' });
  }, [wordIndex, detached, armProgrammatic]);

  // ── Reset al cambiar de capítulo (M12) ────────────────────────────────────
  // Distinguimos navegación EXPLÍCITA (drawer→seekToParagraph, Cap±→
  // bumpGeneration: ambas bumpean generación junto con el capítulo) del
  // AUTO-AVANCE gapless (cambia el capítulo SIN bumpear). Señal: ¿cambió la
  // generación a la vez que el capítulo? Si es auto-avance y el usuario lee
  // despegado, conserva su posición y el modo despegado (el pill sigue
  // disponible para volver); en cualquier otro caso reinicia como siempre.
  // Nota: la generación también bumpea por voz/velocidad SIN cambio de capítulo;
  // esos disparos actualizan prevGenRef y retornan temprano (no tocan el scroll),
  // de modo que un bump de voz NO se confunde con un auto-avance posterior.
  useEffect(() => {
    const el = scrollRef.current;
    const chapterChanged = chapterIndex !== prevChapterRef.current;
    const genChanged = generationId !== prevGenRef.current;
    prevChapterRef.current = chapterIndex;
    prevGenRef.current = generationId;
    if (!chapterChanged) return; // solo cambió generación (voz/velocidad): no tocar
    const explicit = genChanged;
    if (!explicit && detached) return; // auto-avance despegado: no teletransportar
    if (el) {
      if (el.scrollTop !== 0) {
        armProgrammatic(0, true);
        el.scrollTop = 0;
      }
      setScrollTop(0);
    }
    lastManualScrollRef.current = 0;
    setDetached(false);
  }, [chapterIndex, generationId, detached, armProgrammatic]);

  // Limpia el timeout de seguridad del tracking programático al desmontar.
  useEffect(() => () => {
    if (programmaticSafetyRef.current) clearTimeout(programmaticSafetyRef.current);
  }, []);

  // ── Click en párrafo → posiciona ahí; reproduce solo si estaba sonando ───
  const handleParagraphClick = useCallback(
    (i: number) => {
      const wasPlaying = usePlaybackStore.getState().isPlaying;
      // Reposicionar aquí ES la nueva lectura: re-engancha el seguimiento.
      setDetached(false);
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
    // A2: invalida cualquier carga TTS en vuelo. Sin este bump, un fetch que
    // resuelve DESPUÉS de cerrar el libro pasaría los guards de generación y
    // resucitaría audio (y avance de párrafos) en la Biblioteca.
    usePlaybackStore.getState().bumpGeneration();
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
              {/* Línea única compacta: "15 · Chapter Five…" (foco en el texto;
                  las acciones viven ahora en el menú ☆ del AppHeader). */}
              <h2 className="reader-chapter-title reader-chapter-title--line">
                <span className="reader-chapter-num">{chapterIndex + 1}</span>
                <span className="reader-chapter-sep" aria-hidden="true">·</span>
                {chapter.title}
              </h2>
            </div>

            <OfflineDownloadButton doc={doc} chapterIndex={chapterIndex} />

            <span className="reader-progress">
              {percent}%
              <span className="reader-progress__detail">
                {' '}· Cap. {chapterIndex + 1}/{doc.chapters.length} · párr.{' '}
                {paragraphIndex + 1}/{total}
              </span>
            </span>
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

      {detached && (
        <button
          type="button"
          className="reader-return-pill"
          onClick={handleReturnToReading}
          aria-label="Volver a la palabra que se está leyendo"
        >
          <IconReturn /> Volver a la lectura
        </button>
      )}

      {showAnnotations && bookId && (
        <>
          <div
            className="annotations-overlay"
            onClick={() => useDocumentStore.getState().setShowAnnotations(false)}
            aria-hidden="true"
          />
          <AnnotationsPanel
            bookId={bookId}
            onClose={() => useDocumentStore.getState().setShowAnnotations(false)}
          />
        </>
      )}

      <PlayerBar doc={doc} />
    </div>
  );
}
