import { fetchTTS } from '../agents/tts-client';
import { chunkParagraph } from '../agents/chunker';
import { usePlaybackStore } from '../store/playback-store';
import type { ExtractedDoc } from '../types';

const PREFETCH_AHEAD = 2;

export async function prefetchNext(doc: ExtractedDoc): Promise<void> {
  const store = usePlaybackStore.getState();
  const gen = store.generationId;
  const chapter = doc.chapters[store.chapterIndex];
  if (!chapter) return;

  for (let offset = 1; offset <= PREFETCH_AHEAD; offset++) {
    let targetChapter = store.chapterIndex;
    let targetParagraph = store.paragraphIndex + offset;

    // Handle chapter boundary
    while (targetParagraph >= doc.chapters[targetChapter].paragraphs.length) {
      targetParagraph -= doc.chapters[targetChapter].paragraphs.length;
      targetChapter++;
      if (targetChapter >= doc.chapters.length) return; // End of doc
    }

    const paragraph = doc.chapters[targetChapter]?.paragraphs[targetParagraph];
    if (!paragraph) continue;

    // Check if already cached or fetching
    const status = usePlaybackStore.getState().timingsByParagraph.get(paragraph.id);
    if (status && status.status !== 'idle') continue;

    // Mark as fetching
    usePlaybackStore.getState().setParagraphTiming(paragraph.id, { status: 'fetching' });

    // Chunk + fetch (fire and forget — don't block)
    const chunkResult = chunkParagraph({
      paragraphId: paragraph.id,
      paragraphText: paragraph.text,
      voiceId: store.voiceId,
      speed: store.speed,
      maxChunkChars: 500,
      strategy: 'sentence',
    });

    if (!chunkResult.success) continue;

    // Fetch all chunks for this paragraph
    (async () => {
      for (const chunk of chunkResult.data.chunks) {
        // Check generation — discard if stale
        if (usePlaybackStore.getState().generationId !== gen) return;
        const result = await fetchTTS(chunk);
        if (!result.success) return;
      }
      // Mark as ready (timings are stored in cache)
      usePlaybackStore.getState().setParagraphTiming(paragraph.id, { status: 'ready', timings: [] });
    })();
  }
}
