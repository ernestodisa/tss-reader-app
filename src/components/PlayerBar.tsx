import { useEffect, useMemo, useRef } from 'react';
import { usePlayback } from '../hooks/usePlayback';
import { usePlaybackStore } from '../store/playback-store';
import { useDocumentStore } from '../store/document-store';
import { playerAgent } from '../agents/player';
import { fetchTTS } from '../agents/tts-client';
import { chunkParagraph } from '../agents/chunker';
import { VoiceSelector } from './VoiceSelector';
import { SpeedControl } from './SpeedControl';
import { prefetchNext } from '../lib/prefetch';
import { setupMediaSession, clearMediaSession, updatePositionState } from '../lib/media-session';
import type { ExtractedDoc, Paragraph, TTSChunk } from '../types';
import '../styles/player.css';

// Alturas de las 10 barras decorativas del waveform (spec §Player flotante).
const WAVE_BARS = [14, 22, 10, 26, 18, 28, 12, 24, 16, 20];

interface PlayerBarProps {
  doc: ExtractedDoc;
}

export function PlayerBar({ doc }: PlayerBarProps) {
  const {
    isPlaying, isBuffering, voiceId, speed, volume,
    chapterIndex, paragraphIndex, generationId,
    nextParagraph, prevParagraph, nextChapter, prevChapter,
    setVolume, setBuffering, setParagraphTiming,
  } = usePlayback();

  // En dispositivos táctiles (iOS/Android) el volumen lo mandan los botones
  // físicos del sistema: no mostramos slider y la ganancia interna queda en 1
  // (en iOS audio.volume es no-op, pero en Android un valor persistido <1
  // atenuaría sin forma de subirlo).
  const isTouchDevice = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);

  // Aplica el volumen persistido/actual al GainNode del agente. Corre en montaje
  // (restaura la preferencia guardada por zustand persist) y en cada cambio.
  useEffect(() => {
    playerAgent.setVolume(isTouchDevice ? 1 : volume);
  }, [volume, isTouchDevice]);

  // Un párrafo con TTS irrecuperable (texto raro, respuesta 4xx) NO debe
  // congelar el libro: se marca en error y se salta al siguiente, con tope de
  // saltos consecutivos para no ciclar en un capítulo enteramente malo.
  const consecutiveSkipsRef = useRef(0);
  const MAX_CONSECUTIVE_SKIPS = 3;

  const skipToNextAfterError = (gen: number) => {
    if (usePlaybackStore.getState().generationId !== gen) return;
    if (consecutiveSkipsRef.current >= MAX_CONSECUTIVE_SKIPS) {
      usePlaybackStore.getState().pause();
      return;
    }
    consecutiveSkipsRef.current += 1;
    const store = usePlaybackStore.getState();
    const before = `${store.chapterIndex}-${store.paragraphIndex}`;
    store.nextParagraph(doc);
    const after = usePlaybackStore.getState();
    if (`${after.chapterIndex}-${after.paragraphIndex}` === before) {
      usePlaybackStore.getState().pause(); // fin del documento
      return;
    }
    const chapter = doc.chapters[after.chapterIndex];
    const paragraph = chapter?.paragraphs[after.paragraphIndex];
    if (paragraph) void loadAndPlayParagraph(paragraph, voiceId, speed, after.generationId);
  };

  // ── Reproducción PROGRESIVA por chunk (≈1-2 oraciones) ──────────────────
  // Antes se descargaban TODOS los chunks del párrafo antes de sonar — en
  // párrafos grandes el arranque tardaba varios segundos. Ahora la unidad de
  // reproducción es el chunk: suena el primero de inmediato y los siguientes
  // se descargan en background y se encadenan al terminar cada uno (el
  // endCallback distingue "siguiente chunk" de "siguiente párrafo").
  interface ChunkChain {
    gen: number;
    paragraph: Paragraph;
    chunks: TTSChunk[];
    nextIndex: number;
    wordOffset: number; // palabras acumuladas de chunks ya reproducidos
  }
  const chainRef = useRef<ChunkChain | null>(null);

  const fetchChunkWithRetry = async (chunk: TTSChunk, gen: number) => {
    // Errores transitorios (red intermitente, 429) se reintentan solos con
    // backoff antes de rendirse.
    let ttsResult = await fetchTTS(chunk);
    for (let attempt = 1; !ttsResult.success && ttsResult.error.recoverable && attempt <= 3; attempt++) {
      await new Promise((r) => setTimeout(r, ((!ttsResult.success && ttsResult.error.retryAfterMs) || 1500) * attempt));
      if (usePlaybackStore.getState().generationId !== gen) return ttsResult;
      ttsResult = await fetchTTS(chunk);
    }
    return ttsResult;
  };

  /** Reproduce el chunk chainRef.nextIndex y avanza el estado de la cadena. */
  const playChunkFromChain = async (): Promise<void> => {
    const chain = chainRef.current;
    if (!chain) return;
    // En los returns por generación obsoleta hay que LIMPIAR el buffering: si
    // queda en true, el botón ▶ se deshabilita (⏳) para siempre y la app se
    // "muere" tras un cambio de voz/velocidad a media carga. El dueño de la
    // generación nueva lo vuelve a poner en true cuando carga lo suyo.
    if (usePlaybackStore.getState().generationId !== chain.gen) {
      setBuffering(false);
      return;
    }
    const chunk = chain.chunks[chain.nextIndex];
    if (!chunk) return;

    const ttsResult = await fetchChunkWithRetry(chunk, chain.gen);
    if (usePlaybackStore.getState().generationId !== chain.gen) {
      setBuffering(false);
      return;
    }

    if (!ttsResult.success) {
      setParagraphTiming(chain.paragraph.id, { status: 'error', error: ttsResult.error });
      setBuffering(false);
      // empty_audio es "recuperable" solo para efectos de reintento inmediato
      // (bytes frescos, no cachear). Si tras los reintentos SIGUE vacío, el
      // texto no produce audio (separadores exóticos que el filtro del chunker
      // no atrapó): pausar aquí plantaba el libro para siempre — se salta.
      if (ttsResult.error.recoverable && ttsResult.error.code !== 'empty_audio') {
        usePlaybackStore.getState().pause();
      } else {
        skipToNextAfterError(chain.gen);
      }
      return;
    }

    consecutiveSkipsRef.current = 0;
    chain.nextIndex += 1;
    playerAgent.load(chain.paragraph.id, [ttsResult.data.audio], ttsResult.data.words, ttsResult.data.durationMs);
    setParagraphTiming(chain.paragraph.id, { status: 'ready', timings: ttsResult.data.words });
    playerAgent.play();
    usePlaybackStore.getState().play();
    setBuffering(false);
    // Position state → mejor promoción de la notificación de medios en Android
    // (la notificación exenta a la app del congelamiento de background).
    updatePositionState(ttsResult.data.durationMs, 0);

    // Pre-ENCOLADO del siguiente chunk en el player (no solo warm-up del
    // cache): el swap+play en `ended` es síncrono, requisito de Android para
    // que el audio siga en background (un play() tras fetch async se bloquea).
    void queueUpcoming(chain);
  };

  /** Posición del párrafo siguiente sin mutar el store (para pre-encolar). */
  const nextPosition = (c: number, p: number): { chapter: number; paragraph: number } | null => {
    const ch = doc.chapters[c];
    if (ch && p + 1 < ch.paragraphs.length) return { chapter: c, paragraph: p + 1 };
    if (c + 1 < doc.chapters.length && (doc.chapters[c + 1]?.paragraphs.length ?? 0) > 0) {
      return { chapter: c + 1, paragraph: 0 };
    }
    return null;
  };

  // Cadena pre-armada del párrafo siguiente; se activa en el chunkStart con
  // paragraphAdvance (el player ya está sonando su primer chunk).
  const pendingNextChainRef = useRef<ChunkChain | null>(null);

  const queueUpcoming = async (chain: ChunkChain): Promise<void> => {
    pendingNextChainRef.current = null;
    const upcoming = chain.chunks[chain.nextIndex];
    if (upcoming) {
      const r = await fetchTTS(upcoming);
      if (r.success && usePlaybackStore.getState().generationId === chain.gen && chainRef.current === chain) {
        playerAgent.queueNext([r.data.audio], r.data.words, {
          paragraphId: chain.paragraph.id,
          paragraphAdvance: false,
        }, r.data.durationMs);
      }
      return;
    }
    // Último chunk del párrafo sonando: pre-genera los párrafos siguientes en
    // cache y deja ENCOLADO el primer chunk del párrafo que sigue, con su
    // cadena lista para el auto-avance.
    prefetchNext(doc).catch(() => { /* best-effort */ });
    const store = usePlaybackStore.getState();
    const next = nextPosition(store.chapterIndex, store.paragraphIndex);
    if (!next) return;
    const paragraph = doc.chapters[next.chapter]?.paragraphs[next.paragraph];
    if (!paragraph) return;
    const chunkResult = chunkParagraph({
      paragraphId: paragraph.id,
      paragraphText: paragraph.text,
      voiceId: store.voiceId,
      speed: store.speed,
      maxChunkChars: 250,
      strategy: 'sentence',
    });
    if (!chunkResult.success || chunkResult.data.chunks.length === 0) return;
    const r = await fetchTTS(chunkResult.data.chunks[0]);
    if (!r.success) return;
    if (usePlaybackStore.getState().generationId !== chain.gen || chainRef.current !== chain) return;
    pendingNextChainRef.current = {
      gen: chain.gen,
      paragraph,
      chunks: chunkResult.data.chunks,
      nextIndex: 1,
      wordOffset: 0,
    };
    playerAgent.queueNext([r.data.audio], r.data.words, {
      paragraphId: paragraph.id,
      paragraphAdvance: true,
    }, r.data.durationMs);
  };

  // Load and play current paragraph (arma la cadena de chunks y arranca).
  const loadAndPlayParagraph = async (paragraph: Paragraph, voiceId: string, speed: number, gen: number) => {
    setBuffering(true);
    setParagraphTiming(paragraph.id, { status: 'fetching' });

    const chunkResult = chunkParagraph({
      paragraphId: paragraph.id,
      paragraphText: paragraph.text,
      voiceId,
      speed,
      maxChunkChars: 250,
      strategy: 'sentence',
    });

    if (!chunkResult.success || chunkResult.data.chunks.length === 0) {
      if (!chunkResult.success) {
        setParagraphTiming(paragraph.id, { status: 'error', error: chunkResult.error });
      }
      setBuffering(false);
      if (chunkResult.success) {
        // Párrafo sin contenido sonoro: pasa al siguiente sin trabarse.
        skipToNextAfterError(gen);
      } else {
        usePlaybackStore.getState().pause();
      }
      return;
    }

    chainRef.current = {
      gen,
      paragraph,
      chunks: chunkResult.data.chunks,
      nextIndex: 0,
      wordOffset: 0,
    };
    await playChunkFromChain();
  };

  // Handle play/pause toggle
  const handlePlayPause = async () => {
    if (isPlaying) {
      playerAgent.pause();
      usePlaybackStore.getState().pause();
      return;
    }

    // If player already has audio loaded, just resume (not play — sourceNode already started)
    if (playerAgent.getCurrentPositionMs() > 0) {
      playerAgent.resume();
      usePlaybackStore.getState().play();
      return;
    }

    // Otherwise, load current paragraph
    const chapter = doc.chapters[chapterIndex];
    const paragraph = chapter?.paragraphs[paragraphIndex];
    if (paragraph) {
      await loadAndPlayParagraph(paragraph, voiceId, speed, generationId);
    }
  };

  const handleNext = () => {
    playerAgent.fullStop();
    nextParagraph(doc);
    // Kick off prefetch immediately for the new position
    prefetchNext(doc).catch(() => {});
    // Auto-play next paragraph
    const chapter = doc.chapters[usePlaybackStore.getState().chapterIndex];
    const paragraph = chapter?.paragraphs[usePlaybackStore.getState().paragraphIndex];
    if (paragraph) {
      loadAndPlayParagraph(paragraph, voiceId, speed, usePlaybackStore.getState().generationId);
    }
  };

  const handlePrev = () => {
    playerAgent.fullStop();
    prevParagraph(doc);
    // Kick off prefetch immediately for the new position
    prefetchNext(doc).catch(() => {});
    const chapter = doc.chapters[usePlaybackStore.getState().chapterIndex];
    const paragraph = chapter?.paragraphs[usePlaybackStore.getState().paragraphIndex];
    if (paragraph) {
      loadAndPlayParagraph(paragraph, voiceId, speed, usePlaybackStore.getState().generationId);
    }
  };

  // Salto de capítulo: mismo patrón que handleNext/handlePrev (fullStop +
  // navegación en el store + auto-play del párrafo 0 del capítulo destino).
  const handleNextChapter = () => {
    playerAgent.fullStop();
    nextChapter(doc);
    prefetchNext(doc).catch(() => {});
    const state = usePlaybackStore.getState();
    const chapter = doc.chapters[state.chapterIndex];
    const paragraph = chapter?.paragraphs[state.paragraphIndex];
    if (paragraph) {
      loadAndPlayParagraph(paragraph, voiceId, speed, state.generationId);
    }
  };

  const handlePrevChapter = () => {
    playerAgent.fullStop();
    prevChapter(doc);
    prefetchNext(doc).catch(() => {});
    const state = usePlaybackStore.getState();
    const chapter = doc.chapters[state.chapterIndex];
    const paragraph = chapter?.paragraphs[state.paragraphIndex];
    if (paragraph) {
      loadAndPlayParagraph(paragraph, voiceId, speed, state.generationId);
    }
  };

  // MEDIA SESSION: refleja metadata + estado y enruta los controles del SO
  // (pantalla de bloqueo / centro de control) a los handlers de la app. Se
  // re-registra al cambiar de párrafo/capítulo/estado para mantener la metadata
  // y el playbackState al día. El handler `play` pasa por handlePlayPause, cuyo
  // camino de resume() reanuda el AudioContext suspendido en background.
  useEffect(() => {
    const chapter = doc.chapters[chapterIndex];
    setupMediaSession({
      title: doc.title,
      author: doc.author,
      chapter: chapter?.title,
      playbackState: isPlaying ? 'playing' : 'paused',
      handlers: {
        play: () => {
          if (!usePlaybackStore.getState().isPlaying) handlePlayPause();
        },
        pause: () => {
          if (usePlaybackStore.getState().isPlaying) handlePlayPause();
        },
        next: handleNext,
        prev: handlePrev,
        nextChapter: handleNextChapter,
        prevChapter: handlePrevChapter,
      },
    });
  }, [doc, isPlaying, chapterIndex, paragraphIndex]);

  // Limpia la Media Session al desmontar el PlayerBar.
  useEffect(() => {
    return () => clearMediaSession();
  }, []);

  // Wire karaoke word tracking + auto-advance when audio ends
  useEffect(() => {
    // BUG FIX #1: wordIndex must be pushed to the store so KaraokeText highlights the active word
    playerAgent.setWordChangeCallback((wordIndex) => {
      // El índice llega relativo al CHUNK sonando; el karaoke usa índices
      // globales del párrafo → se suma el offset de chunks ya reproducidos.
      const offset = chainRef.current?.wordOffset ?? 0;
      usePlaybackStore.getState().setWordIndex(offset + wordIndex);
    });

    // Audio corrupto/indecodificable (raro tras validar bytes en fetchTTS, pero
    // posible con un MP3 truncado): el <audio> emite `error` y jamás `ended`, así
    // que sin esto la reproducción moría en silencio. Lo tratamos como chunk
    // fallido y saltamos hacia adelante (con el tope de saltos consecutivos que
    // pausa con gracia si un tramo entero está corrupto).
    // Arranque de un chunk PRE-ENCOLADO (swap síncrono en `ended`): actualiza
    // la contabilidad de la cadena y encola el siguiente. Con paragraphAdvance,
    // activa la cadena pre-armada y mueve el store al párrafo nuevo.
    playerAgent.setChunkStartCallback((meta, timings) => {
      const store = usePlaybackStore.getState();
      const staleChain = meta.paragraphAdvance ? pendingNextChainRef.current : chainRef.current;

      // La generación cambió (voz/velocidad) entre encolar y arrancar: el
      // chunk que acaba de empezar a sonar es HUÉRFANO de la generación vieja.
      // Sin esto, el audio sigue en el párrafo siguiente mientras el store (y
      // el karaoke) se quedan clavados en el recién terminado. Se corta al
      // huérfano y se re-arranca la posición correcta con los ajustes nuevos.
      if (!staleChain || store.generationId !== staleChain.gen) {
        pendingNextChainRef.current = null;
        playerAgent.fullStop();
        if (meta.paragraphAdvance) {
          store.nextParagraph(useDocumentStore.getState().doc || doc);
        }
        const s2 = usePlaybackStore.getState();
        const paragraph = doc.chapters[s2.chapterIndex]?.paragraphs[s2.paragraphIndex];
        if (paragraph) void loadAndPlayParagraph(paragraph, s2.voiceId, s2.speed, s2.generationId);
        return;
      }

      // Duración del chunk que arranca (para el position state): fin de la
      // última palabra según sus timings.
      const lastT = timings[timings.length - 1];
      if (lastT) updatePositionState(lastT.offsetMs + lastT.durationMs, 0);

      if (meta.paragraphAdvance) {
        const nextChain = pendingNextChainRef.current!;
        pendingNextChainRef.current = null;
        chainRef.current = nextChain;
        store.nextParagraph(useDocumentStore.getState().doc || doc);
        store.setWordIndex(0);
        setParagraphTiming(meta.paragraphId, { status: 'ready', timings });
        void queueUpcoming(nextChain);
        return;
      }
      const chain = chainRef.current!;
      const played = chain.chunks[chain.nextIndex - 1];
      if (played) {
        chain.wordOffset += played.text.split(/\s+/).filter(Boolean).length;
      }
      chain.nextIndex += 1;
      void queueUpcoming(chain);
    });

    // play() rechazado (background de Android, autoplay): UI honesta en pausa
    // — el siguiente gesto o el control de Media Session reanudan.
    playerAgent.setPlayBlockedCallback(() => {
      usePlaybackStore.getState().pause();
    });

    playerAgent.setErrorCallback(() => {
      const chain = chainRef.current;
      const gen = chain ? chain.gen : usePlaybackStore.getState().generationId;
      if (usePlaybackStore.getState().generationId !== gen) return;
      setBuffering(false);
      skipToNextAfterError(gen);
    });

    // Al terminar el audio: siguiente CHUNK del párrafo si la cadena tiene
    // más; si no, auto-advance al siguiente párrafo.
    playerAgent.setEndCallback(() => {
      const chain = chainRef.current;
      if (chain && chain.nextIndex < chain.chunks.length &&
          usePlaybackStore.getState().generationId === chain.gen) {
        // Acumula las palabras del chunk que acaba de sonar para el karaoke.
        const played = chain.chunks[chain.nextIndex - 1];
        if (played) {
          chain.wordOffset += played.text.split(/\s+/).filter(Boolean).length;
        }
        void playChunkFromChain();
        return;
      }
      const store = usePlaybackStore.getState();
      const currentDoc = useDocumentStore.getState().doc || doc;
      if (!currentDoc) {
        store.stop();
        return;
      }
      const prevCh = store.chapterIndex;
      const prevPar = store.paragraphIndex;
      store.nextParagraph(currentDoc);
      const after = usePlaybackStore.getState();
      // nextParagraph is a no-op at end of document → stop playback in the store
      if (after.chapterIndex === prevCh && after.paragraphIndex === prevPar) {
        after.stop();
        return;
      }
      const chapter = currentDoc.chapters[after.chapterIndex];
      const paragraph = chapter?.paragraphs[after.paragraphIndex];
      if (paragraph) {
        loadAndPlayParagraph(paragraph, store.voiceId, store.speed, store.generationId);
      } else {
        usePlaybackStore.getState().stop();
      }
    });

    return () => {
      playerAgent.destroy();
    };
  }, [doc]);

  return (
    <div className={`fp-player${isPlaying ? ' is-playing' : ''}`}>
      <div className="fp-transport">
        <button
          className="fp-chapbtn"
          onClick={handlePrevChapter}
          disabled={isBuffering || chapterIndex === 0}
          title="Capítulo anterior"
          aria-label="Capítulo anterior"
        >
          Cap −
        </button>
        <button className="fp-round" onClick={handlePrev} disabled={isBuffering} title="Párrafo anterior" aria-label="Párrafo anterior">⏮︎</button>
        <button className="fp-play" onClick={handlePlayPause} disabled={isBuffering} aria-label={isPlaying ? 'Pausar' : 'Reproducir'}>
          {isBuffering ? '⏳' : isPlaying ? '❚❚' : '▶'}
        </button>
        <button className="fp-round" onClick={handleNext} disabled={isBuffering} title="Párrafo siguiente" aria-label="Párrafo siguiente">⏭︎</button>
        <button
          className="fp-chapbtn"
          onClick={handleNextChapter}
          disabled={isBuffering || chapterIndex >= doc.chapters.length - 1}
          title="Capítulo siguiente"
          aria-label="Capítulo siguiente"
        >
          Cap +
        </button>
      </div>

      <div className="fp-wave" aria-hidden="true">
        {WAVE_BARS.map((h, i) => (
          <span key={i} style={{ height: `${h}px`, animationDelay: `${i * 0.09}s` }} />
        ))}
      </div>

      <div className="fp-spacer" />

      <VoiceSelector />

      <div className="fp-sep">
        <SpeedControl />
      </div>

      {!isTouchDevice && (
        <label className="fp-sep fp-vol" title="Volumen">
          <span className="fp-vol-label" aria-hidden="true">vol</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            aria-label="Volumen"
            onChange={(e) => setVolume(Number(e.target.value))}
          />
        </label>
      )}
    </div>
  );
}
