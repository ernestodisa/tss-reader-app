import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ExtractedDoc, TimingStatus } from '../types';

interface PlaybackStore {
  // Position
  chapterIndex: number;
  paragraphIndex: number;
  wordIndex: number;
  positionMs: number;

  // State
  isPlaying: boolean;
  isBuffering: boolean;

  // Config
  voiceId: string;
  speed: number;
  volume: number;
  generationId: number;

  // Timings
  timingsByParagraph: Map<string, TimingStatus>;

  // Actions
  play: () => void;
  pause: () => void;
  stop: () => void;
  setVoice: (id: string) => void;
  setSpeed: (speed: number) => void;
  setVolume: (volume: number) => void;
  setParagraphTiming: (paragraphId: string, status: TimingStatus) => void;
  setWordIndex: (index: number) => void;
  setPositionMs: (ms: number) => void;
  setBuffering: (buffering: boolean) => void;
  seekToParagraph: (chapterIndex: number, paragraphIndex: number) => void;
  nextParagraph: (doc: ExtractedDoc) => void;
  prevParagraph: (doc: ExtractedDoc) => void;
  nextChapter: (doc: ExtractedDoc) => void;
  prevChapter: (doc: ExtractedDoc) => void;
  bumpGeneration: () => void;
}

export const usePlaybackStore = create<PlaybackStore>()(
  persist(
    (set) => ({
  chapterIndex: 0,
  paragraphIndex: 0,
  wordIndex: 0,
  positionMs: 0,
  isPlaying: false,
  isBuffering: false,
  voiceId: 'es-MX-DaliaNeural',
  speed: 1.0,
  volume: 1.0,
  generationId: 0,
  timingsByParagraph: new Map(),

  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  stop: () => set({ isPlaying: false, positionMs: 0, wordIndex: 0 }),

  setVoice: (id: string) => set((s) => ({
    voiceId: id,
    generationId: s.generationId + 1,
  })),

  setSpeed: (speed: number) => set((s) => ({
    speed,
    generationId: s.generationId + 1,
  })),

  // El volumen NO bumpea generación: es ganancia en vivo sobre el mismo audio,
  // no requiere re-fetch de TTS como voiceId/speed.
  setVolume: (volume: number) => set({
    volume: Math.max(0, Math.min(1, volume)),
  }),

  setParagraphTiming: (paragraphId, status) => set((s) => {
    const newMap = new Map(s.timingsByParagraph);
    newMap.set(paragraphId, status);
    return { timingsByParagraph: newMap };
  }),

  setWordIndex: (index: number) => set({ wordIndex: index }),
  setPositionMs: (ms: number) => set({ positionMs: ms }),
  setBuffering: (buffering: boolean) => set({ isBuffering: buffering }),

  seekToParagraph: (chapterIndex: number, paragraphIndex: number) => set((s) => ({
    chapterIndex,
    paragraphIndex,
    wordIndex: 0,
    positionMs: 0,
    generationId: s.generationId + 1,
  })),

  // IMPORTANTE — estas 4 acciones (nextParagraph/prevParagraph/nextChapter/
  // prevChapter) NO bumpean generación A PROPÓSITO. El avance AUTOMÁTICO gapless
  // (la rama de avance del endCallback y el chunk que ya viene PRE-ENCOLADO en
  // el player) depende de CONSERVAR la generación: bumpear aquí invalidaría en
  // sus guards el chunk pre-encolado en vuelo y cortaría la continuidad del
  // audio. La navegación INICIADA POR EL USUARIO sí debe invalidar lo viejo,
  // pero lo hace en PlayerBar (bumpGeneration tras el fullStop), no aquí. NO
  // mover el bump a estas acciones "para arreglar carreras": rompe el gapless.
  nextParagraph: (doc: ExtractedDoc) => set((s) => {
    const chapter = doc.chapters[s.chapterIndex];
    // B2: con índices restaurados de un libro re-extraído con menos capítulos,
    // s.chapterIndex puede quedar fuera de rango → sin este guard,
    // chapter.paragraphs lanza TypeError en el set del store.
    if (!chapter) return {};
    if (s.paragraphIndex < chapter.paragraphs.length - 1) {
      return { paragraphIndex: s.paragraphIndex + 1, wordIndex: 0, positionMs: 0 };
    }
    // Move to next chapter
    if (s.chapterIndex < doc.chapters.length - 1) {
      return {
        chapterIndex: s.chapterIndex + 1,
        paragraphIndex: 0,
        wordIndex: 0,
        positionMs: 0,
      };
    }
    return {}; // End of document
  }),

  prevParagraph: (doc: ExtractedDoc) => set((s) => {
    if (s.paragraphIndex > 0) {
      return { paragraphIndex: s.paragraphIndex - 1, wordIndex: 0, positionMs: 0 };
    }
    if (s.chapterIndex > 0) {
      const prevChapter = doc.chapters[s.chapterIndex - 1];
      // B2: índice fuera de rango (libro re-extraído) → guard contra TypeError
      // en prevChapter.paragraphs.
      if (!prevChapter) return {};
      return {
        chapterIndex: s.chapterIndex - 1,
        paragraphIndex: prevChapter.paragraphs.length - 1,
        wordIndex: 0,
        positionMs: 0,
      };
    }
    return {};
  }),

  // Salto por capítulo: van al párrafo 0 del capítulo destino. Mismo patrón que
  // nextParagraph (sin bump de generación; el re-fetch lo dispara el PlayerBar
  // vía loadAndPlayParagraph con el generationId actual tras el fullStop).
  nextChapter: (doc: ExtractedDoc) => set((s) => {
    if (s.chapterIndex < doc.chapters.length - 1) {
      return {
        chapterIndex: s.chapterIndex + 1,
        paragraphIndex: 0,
        wordIndex: 0,
        positionMs: 0,
      };
    }
    return {}; // Ya en el último capítulo
  }),

  prevChapter: (_doc: ExtractedDoc) => set((s) => {
    if (s.chapterIndex > 0) {
      return {
        chapterIndex: s.chapterIndex - 1,
        paragraphIndex: 0,
        wordIndex: 0,
        positionMs: 0,
      };
    }
    return {}; // Ya en el primer capítulo
  }),

  bumpGeneration: () => set((s) => ({ generationId: s.generationId + 1 })),
    }),
    {
      name: 'folio-playback',
      // CUIDADO: timingsByParagraph es un Map no serializable — NO lo persistas.
      // Solo persistimos preferencias del usuario.
      partialize: (s) => ({
        voiceId: s.voiceId,
        speed: s.speed,
        volume: s.volume,
      }),
    },
  ),
);