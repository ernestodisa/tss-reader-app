import { useMemo } from 'react';
import { usePlaybackStore } from '../store/playback-store';
import type { WordTiming } from '../types';

// `isCurrent` indica si este párrafo es EL párrafo posicionado actualmente
// (doc.chapters[chapterIndex].paragraphs[paragraphIndex]). El highlight de
// karaoke SOLO debe aplicar al párrafo actual: sin este guard, cualquier
// párrafo con timings 'ready' en caché (p. ej. prefetch del siguiente) se
// resaltaría al mismo tiempo que el activo. El ReaderView lo deriva del doc y
// lo pasa por prop. Default true para no romper usos que ya garantizan que solo
// montan el párrafo actual.
export function useKaraoke(paragraphId: string, isCurrent: boolean = true) {
  const wordIndex = usePlaybackStore((s) => s.wordIndex);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const timingsStatus = usePlaybackStore((s) => s.timingsByParagraph.get(paragraphId));

  const timings: WordTiming[] | null = useMemo(() => {
    if (timingsStatus?.status === 'ready') return timingsStatus.timings;
    return null;
  }, [timingsStatus]);

  const isActive = useMemo(() => {
    // Activo solo si es el párrafo actual, está sonando y ya hay timings.
    return isCurrent && isPlaying && timings !== null;
  }, [isCurrent, isPlaying, timings]);

  return {
    wordIndex,
    isActive,
    timings,
    isReady: timingsStatus?.status === 'ready',
    isFetching: timingsStatus?.status === 'fetching',
  };
}
