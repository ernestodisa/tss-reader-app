import { useEffect } from 'react';
import { usePlayback } from '../hooks/usePlayback';
import { usePlaybackStore } from '../store/playback-store';
import { playerAgent } from '../agents/player';
import { fetchTTS } from '../agents/tts-client';
import { chunkParagraph } from '../agents/chunker';
import { decodeAudio } from '../lib/audio-utils';
import { VoiceSelector } from './VoiceSelector';
import { SpeedControl } from './SpeedControl';
import type { ExtractedDoc, Paragraph } from '../types';

interface PlayerBarProps {
  doc: ExtractedDoc;
}

export function PlayerBar({ doc }: PlayerBarProps) {
  const {
    isPlaying, isBuffering, voiceId, speed,
    chapterIndex, paragraphIndex, generationId,
    nextParagraph, prevParagraph,
    setBuffering, setParagraphTiming,
  } = usePlayback();

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
      return;
    }

    // Fetch TTS for all chunks in the plan
    const plan = chunkResult.data;
    const allTimings = [];
    const allAudioBuffers: AudioBuffer[] = [];

    for (const chunk of plan.chunks) {
      // Check generation — discard if stale
      if (usePlaybackStore.getState().generationId !== gen) return;

      const ttsResult = await fetchTTS(chunk);
      if (!ttsResult.success) {
        setParagraphTiming(paragraph.id, { status: 'error', error: ttsResult.error });
        setBuffering(false);
        return;
      }

      const audioBuffer = await decodeAudio(ttsResult.data.audio);
      allAudioBuffers.push(audioBuffer);
      allTimings.push(...ttsResult.data.words);
    }

    // For MVP: use the first chunk's audio (simplification — multi-chunk concatenation is post-MVP)
    // In practice, most paragraphs fit in one chunk
    const audio = allAudioBuffers[0];
    if (audio) {
      playerAgent.load(paragraph.id, audio, allTimings);
      setParagraphTiming(paragraph.id, { status: 'ready', timings: allTimings });
      playerAgent.play();
    }

    setBuffering(false);
  };

  // Handle play/pause toggle
  const handlePlayPause = async () => {
    if (isPlaying) {
      playerAgent.pause();
      return;
    }

    // If player already has audio loaded, just resume
    if (playerAgent.getCurrentPositionMs() > 0) {
      playerAgent.play();
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
    const chapter = doc.chapters[usePlaybackStore.getState().chapterIndex];
    const paragraph = chapter?.paragraphs[usePlaybackStore.getState().paragraphIndex];
    if (paragraph) {
      loadAndPlayParagraph(paragraph, voiceId, speed, usePlaybackStore.getState().generationId);
    }
  };

  // Auto-advance when audio ends
  useEffect(() => {
    playerAgent.setWordChangeCallback(() => {
      // Word change tracking handled by rAF in playerAgent
    });

    return () => {
      playerAgent.destroy();
    };
  }, []);

  return (
    <div className="player-bar">
      <div className="player-controls">
        <button onClick={handlePrev} disabled={isBuffering}>⏮</button>
        <button onClick={handlePlayPause} disabled={isBuffering}>
          {isBuffering ? '⏳' : isPlaying ? '⏸' : '▶'}
        </button>
        <button onClick={handleNext} disabled={isBuffering}>⏭</button>
      </div>
      <div className="player-options">
        <VoiceSelector />
        <SpeedControl />
      </div>
    </div>
  );
}
