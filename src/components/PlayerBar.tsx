import { useEffect, useRef } from 'react';
import { usePlayback } from '../hooks/usePlayback';
import { usePlaybackStore } from '../store/playback-store';
import { useDocumentStore } from '../store/document-store';
import { playerAgent } from '../agents/player';
import { fetchTTS } from '../agents/tts-client';
import { chunkParagraph } from '../agents/chunker';
import { VoiceSelector } from './VoiceSelector';
import { SpeedControl } from './SpeedControl';
import { prefetchNext } from '../lib/prefetch';
import { setupMediaSession, clearMediaSession } from '../lib/media-session';
import type { ExtractedDoc, Paragraph, WordTiming } from '../types';
import '../styles/player.css';

// Alturas de las 10 barras decorativas del waveform (spec §Player flotante).
const WAVE_BARS = [14, 22, 10, 26, 18, 28, 12, 24, 16, 20];

// Duración de un chunk MP3 de Edge TTS sin decodificarlo: el formato es CBR
// 48 kbps (audio-24khz-48kbitrate-mono-mp3) → 6000 bytes/seg → ms = bytes / 6.
// Se usa para desplazar los timings de chunks posteriores; el durationMs del
// worker (última palabra) subestima por el silencio de cola, así que se toma
// el mayor de los dos.
function chunkDurationMs(bytes: number, reportedMs: number): number {
  return Math.max(reportedMs, Math.round(bytes / 6));
}

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

  // Aplica el volumen persistido/actual al GainNode del agente. Corre en montaje
  // (restaura la preferencia guardada por zustand persist) y en cada cambio.
  useEffect(() => {
    playerAgent.setVolume(volume);
  }, [volume]);

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

  // Load and play current paragraph
  const loadAndPlayParagraph = async (paragraph: Paragraph, voiceId: string, speed: number, gen: number) => {
    setBuffering(true);
    setParagraphTiming(paragraph.id, { status: 'fetching' });

    // Chunk
    const chunkResult = chunkParagraph({
      paragraphId: paragraph.id,
      paragraphText: paragraph.text,
      voiceId,
      speed,
      maxChunkChars: 500,
      strategy: 'sentence',
    });

    if (!chunkResult.success) {
      setParagraphTiming(paragraph.id, { status: 'error', error: chunkResult.error });
      setBuffering(false);
      usePlaybackStore.getState().pause();
      return;
    }

    // Fetch TTS for all chunks in the plan
    const plan = chunkResult.data;
    const allTimings: WordTiming[] = [];
    const mp3Parts: ArrayBuffer[] = [];
    let accumulatedMs = 0; // duration of all previous chunks' audio

    for (const chunk of plan.chunks) {
      // Check generation — discard if stale
      if (usePlaybackStore.getState().generationId !== gen) return;

      // Errores transitorios (red intermitente, 429) se reintentan solos con
      // backoff antes de rendirse — sin esto, una conexión inestable dejaba la
      // app "trabada" en el mismo párrafo esperando un reintento manual.
      let ttsResult = await fetchTTS(chunk);
      for (let attempt = 1; !ttsResult.success && ttsResult.error.recoverable && attempt <= 3; attempt++) {
        await new Promise((r) => setTimeout(r, (ttsResult.success ? 0 : ttsResult.error.retryAfterMs || 1500) * attempt));
        if (usePlaybackStore.getState().generationId !== gen) return;
        ttsResult = await fetchTTS(chunk);
      }
      if (!ttsResult.success) {
        setParagraphTiming(paragraph.id, { status: 'error', error: ttsResult.error });
        setBuffering(false);
        if (ttsResult.error.recoverable) {
          // Red caída de verdad tras 3 reintentos: pausa para reintento manual.
          usePlaybackStore.getState().pause();
        } else {
          // Error permanente de ESTE párrafo: sáltalo para no trabar el libro.
          skipToNextAfterError(gen);
        }
        return;
      }

      mp3Parts.push(ttsResult.data.audio);
      // Chunk timings are relative to the chunk's own audio; shift them by the
      // accumulated duration of previous chunks so offsets are paragraph-absolute.
      for (const w of ttsResult.data.words) {
        allTimings.push({ ...w, offsetMs: w.offsetMs + accumulatedMs });
      }
      accumulatedMs += chunkDurationMs(ttsResult.data.audio.byteLength, ttsResult.data.durationMs);
    }

    // Los bytes MP3 CBR son concatenables como un solo stream: el <audio> los
    // reproduce de corrido y los timings desplazados quedan alineados.
    if (mp3Parts.length > 0) {
      consecutiveSkipsRef.current = 0; // párrafo sano: resetea el contador de saltos
      playerAgent.load(paragraph.id, mp3Parts, allTimings);
      setParagraphTiming(paragraph.id, { status: 'ready', timings: allTimings });
      playerAgent.play();
      // Sync store: real playback just started → button shows ⏸, karaoke activates
      usePlaybackStore.getState().play();
      // Start prefetching next paragraphs (best-effort, fire-and-forget)
      prefetchNext(doc).catch(() => { /* silent fail — prefetch is best-effort */ });
    }

    setBuffering(false);
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
      usePlaybackStore.getState().setWordIndex(wordIndex);
    });

    // BUG FIX #3: auto-advance to next paragraph when audio finishes
    playerAgent.setEndCallback(() => {
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
        <button className="fp-round" onClick={handlePrev} disabled={isBuffering} title="Párrafo anterior" aria-label="Párrafo anterior">⏮</button>
        <button className="fp-play" onClick={handlePlayPause} disabled={isBuffering} aria-label={isPlaying ? 'Pausar' : 'Reproducir'}>
          {isBuffering ? '⏳' : isPlaying ? '❚❚' : '▶'}
        </button>
        <button className="fp-round" onClick={handleNext} disabled={isBuffering} title="Párrafo siguiente" aria-label="Párrafo siguiente">⏭</button>
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
    </div>
  );
}
