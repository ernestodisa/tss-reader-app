import { usePlaybackStore } from '../store/playback-store';

export function usePlayback() {
  const store = usePlaybackStore();
  return {
    isPlaying: store.isPlaying,
    isBuffering: store.isBuffering,
    chapterIndex: store.chapterIndex,
    paragraphIndex: store.paragraphIndex,
    wordIndex: store.wordIndex,
    positionMs: store.positionMs,
    voiceId: store.voiceId,
    speed: store.speed,
    volume: store.volume,
    generationId: store.generationId,
    play: store.play,
    pause: store.pause,
    stop: store.stop,
    setVoice: store.setVoice,
    setSpeed: store.setSpeed,
    setVolume: store.setVolume,
    seekToParagraph: store.seekToParagraph,
    nextParagraph: store.nextParagraph,
    prevParagraph: store.prevParagraph,
    nextChapter: store.nextChapter,
    prevChapter: store.prevChapter,
    setParagraphTiming: store.setParagraphTiming,
    setWordIndex: store.setWordIndex,
    setPositionMs: store.setPositionMs,
    setBuffering: store.setBuffering,
    bumpGeneration: store.bumpGeneration,
  };
}
