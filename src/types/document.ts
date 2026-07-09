export interface ExtractedDoc {
  title: string;
  author?: string;
  chapters: Chapter[];
  sourceType: 'pdf' | 'epub';
  language?: string;
  totalPages?: number;
  totalCharacters: number;
  estimatedDurationMs?: number;
  coverImage?: ArrayBuffer;
  metadata?: Record<string, string>;
}

export interface Chapter {
  id: string;
  title: string;
  paragraphs: Paragraph[];
  index: number;
  totalCharacters: number;
  estimatedDurationMs?: number;
}

export interface Paragraph {
  id: string;
  text: string;
  chapterId: string;
  page?: number;
}

export interface TokenPosition {
  wordIndex: number;
  charStart: number;
  charEnd: number;
}
