export interface Bookmark {
  id: string;
  bookId: string;
  chapterIndex: number;
  paragraphIndex: number;
  createdAt: number;
  /** Fragmento corto del texto del párrafo, para mostrar en el panel sin re-leer el doc. */
  excerpt: string;
}

export interface Note {
  id: string;
  bookId: string;
  chapterIndex: number;
  paragraphIndex: number;
  createdAt: number;
  excerpt: string;
  text: string;
}
