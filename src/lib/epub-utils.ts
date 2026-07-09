import ePub from 'epubjs';
import type { Chapter, Paragraph } from '../types';

export async function extractEPub(file: File): Promise<{ title: string; author?: string; chapters: Chapter[] }> {
  const arrayBuffer = await file.arrayBuffer();
  const book = ePub(arrayBuffer);

  const title = book.packaging?.metadata?.title || file.name.replace(/\.epub$/i, '');
  const author = book.packaging?.metadata?.creator;

  const chapters: Chapter[] = [];
  let globalParaCounter = 0;

  const spineItems = await book.loaded.spine;

  for (let i = 0; i < spineItems.length; i++) {
    const item = spineItems[i];
    if (!item.href) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const section = book.spine.get(i) as any;
    const doc: Document = section.load(book.load.bind(book));
    const text = doc.body?.textContent || '';

    // Split into paragraphs
    const paraTexts: string[] = text
      .split(/\n\n+|\r\n\r\n+/)
      .map((p: string) => p.trim())
      .filter((p: string) => p.length > 0);

    const paragraphs: Paragraph[] = paraTexts.map((paraText: string, j: number) => ({
      id: `epub-p-${i}-${j}`,
      text: paraText,
      chapterId: `epub-ch-${i}`,
    }));

    globalParaCounter += paragraphs.length;

    if (paragraphs.length > 0) {
      const chapterTitle = doc.querySelector('h1, h2, title')?.textContent || `Capítulo ${i + 1}`;
      chapters.push({
        id: `epub-ch-${i}`,
        title: chapterTitle,
        paragraphs,
        index: i + 1,
        totalCharacters: paragraphs.reduce((sum, p) => sum + p.text.length, 0),
      });
    }

    section.unload();
  }

  book.destroy();

  return { title, author, chapters };
}