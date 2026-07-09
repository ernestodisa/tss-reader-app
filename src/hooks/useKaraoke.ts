import { useMemo } from 'react';
import { usePlaybackStore } from '../store/playback-store';
import type { WordTiming } from '../types';

export function useKaraoke(paragraphId: string) {
  const wordIndex = usePlaybackStore((s) => s.wordIndex);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const timingsStatus = usePlaybackStore((s) => s.timingsByParagraph.get(paragraphId));

  const timings: WordTiming[] | null = useMemo(() => {
    if (timingsStatus?.status === 'ready') return timingsStatus.timings;
    return null;
  }, [timingsStatus]);

  const isActive = useMemo(() => {
    // This paragraph is active if it's the current paragraph being played
    return isPlaying && timings !== null;
  }, [isPlaying, timings]);

  return {
    wordIndex,
    isActive,
    timings,
    isReady: timingsStatus?.status === 'ready',
    isFetching: timingsStatus?.status === 'fetching',
  };
}
