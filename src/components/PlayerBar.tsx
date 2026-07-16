import { useEffect } from 'react';
import { usePlayback } from '../hooks/usePlayback';
import { usePlaybackStore } from '../store/playback-store';
import { useDocumentStore } from '../store/document-store';
import { playerAgent } from '../agents/player';
import { fetchTTS } from '../agents/tts-client';
import { chunkParagraph } from '../agents/chunker';
import { decodeAudio } from '../lib/audio-utils';
import { VoiceSelector } from './VoiceSelector';
import { SpeedControl } from './SpeedControl';
import { prefetchNext } from '../lib/prefetch';
import { setupMediaSession, clearMediaSession } from '../lib/media-session';
import type { ExtractedDoc, Paragraph, WordTiming } from '../types';

// Concatenate decoded chunk buffers into a single AudioBuffer so multi-chunk
// paragraphs play in full and karaoke offsets can be made absolute.
function concatAudioBuffers(buffers: AudioBuffer[]): AudioBuffer {
  if (buffers.length === 1) return buffers[0];
  const sampleRate = buffers[0].sampleRate;
  const numberOfChannels = Math.max(...buffers.map((b) => b.numberOfChannels));
  const length = buffers.reduce((sum, b) => sum + b.length, 0);
  const out = new AudioBuffer({ length, numberOfChannels, sampleRate });
  let offset = 0;
  for (const b of buffers) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      // If a chunk has fewer channels, reuse its last available channel
      const src = b.getChannelData(Math.min(ch, b.numberOfChannels - 1));
      out.getChannelData(ch).set(src, offset);
    }
    offset += b.length;
  }
  return out;
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
    const allAudioBuffers: AudioBuffer[] = [];
    let accumulatedMs = 0; // duration of all previous chunks' audio

    for (const chunk of plan.chunks) {
      // Check generation — discard if stale
      if (usePlaybackStore.getState().generationId !== gen) return;

      const ttsResult = await fetchTTS(chunk);
      if (!ttsResult.success) {
        setParagraphTiming(paragraph.id, { status: 'error', error: ttsResult.error });
        setBuffering(false);
        usePlaybackStore.getState().pause();
        return;
      }

      const audioBuffer = await decodeAudio(ttsResult.data.audio);
      allAudioBuffers.push(audioBuffer);
      // Chunk timings are relative to the chunk's own audio; shift them by the
      // accumulated duration of previous chunks so offsets are paragraph-absolute.
      for (const w of ttsResult.data.words) {
        allTimings.push({ ...w, offsetMs: w.offsetMs + accumulatedMs });
      }
      accumulatedMs += audioBuffer.duration * 1000;
    }

    // Concatenate all chunk buffers into one so the whole paragraph plays
    // and the shifted timings above line up with the audio.
    if (allAudioBuffers.length > 0) {
      const audio = concatAudioBuffers(allAudioBuffers);
      playerAgent.load(paragraph.id, audio, allTimings);
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
    <div className="player-bar">
      <div className="player-controls">
        <button
          onClick={handlePrevChapter}
          disabled={isBuffering || chapterIndex === 0}
          title="Capítulo anterior"
          aria-label="Capítulo anterior"
        >
          Cap −
        </button>
        <button onClick={handlePrev} disabled={isBuffering} title="Párrafo anterior" aria-label="Párrafo anterior">⏮</button>
        <button onClick={handlePlayPause} disabled={isBuffering} aria-label={isPlaying ? 'Pausar' : 'Reproducir'}>
          {isBuffering ? '⏳' : isPlaying ? '⏸' : '▶'}
        </button>
        <button onClick={handleNext} disabled={isBuffering} title="Párrafo siguiente" aria-label="Párrafo siguiente">⏭</button>
        <button
          onClick={handleNextChapter}
          disabled={isBuffering || chapterIndex >= doc.chapters.length - 1}
          title="Capítulo siguiente"
          aria-label="Capítulo siguiente"
        >
          Cap +
        </button>
      </div>
      <div className="player-options">
        <VoiceSelector />
        <SpeedControl />
        <label className="volume-control" title="Volumen">
          <span aria-hidden="true">🔊</span>
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
    </div>
  );
}
