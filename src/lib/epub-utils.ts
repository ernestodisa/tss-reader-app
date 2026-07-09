import ePub from 'epubjs';
import type { Chapter, Paragraph } from '../types';

export async function extractEPub(file: File): Promise<{ title: string; author?: string; chapters: Chapter[] }> {
  const arrayBuffer = await file.arrayBuffer();
  const book = ePub(arrayBuffer);

  // Wait for book metadata to load
  await book.ready;

  const title = book.packaging?.metadata?.title || file.name.replace(/\.epub$/i, '');
  const author = book.packaging?.metadata?.creator;

  const chapters: Chapter[] = [];

  // Use book.spine.spineItems — the actual array of spine items
  // epubjs types are incomplete, cast to access the array
  const spine = book.spine as unknown as { items: { href: string; load: (fn: typeof book.load) => Promise<Document>; unload: () => void }[] };
  const spineItems = spine.items || [];

  for (let i = 0; i < spineItems.length; i++) {
    const item = spineItems[i];

    // Skip cover, nav, toc items
    if (!item?.href) continue;

    try {
      // item.load() returns a Promise<Document>
      const doc = await item.load(book.load.bind(book));
      if (!doc) continue;

      const body = doc.body || doc.documentElement;
      const text = body?.textContent || '';

      if (!text.trim()) {
        item.unload();
        continue;
      }

      // Clean up text: remove excessive whitespace, split into paragraphs
      const cleanText = text
        .replace(/\s+/g, ' ')
        .trim();

      // Split by sentence groups (heuristic: 2+ sentences per paragraph)
      // Try paragraph tags first, fall back to sentence splitting
      const paraElements = doc.querySelectorAll('p, div, h1, h2, h3');
      let paraTexts: string[];

      if (paraElements.length > 1) {
        paraTexts = Array.from(paraElements)
          .map((el: Element) => el.textContent?.trim() || '')
          .filter((t: string) => t.length > 2);
      } else {
        // Fall back: split by double newline or period groups
        paraTexts = cleanText
          .split(/\n+/)
          .map((p: string) => p.trim())
          .filter((p: string) => p.length > 0);
      }

      if (paraTexts.length === 0) {
        item.unload();
        continue;
      }

      const paragraphs: Paragraph[] = paraTexts.map((paraText, j) => ({
        id: `epub-p-${i}-${j}`,
        text: paraText,
        chapterId: `epub-ch-${i}`,
      }));

      if (paragraphs.length > 0) {
        const chapterTitle = doc.querySelector('h1, h2, h3, title')?.textContent?.trim() || `Capítulo ${i + 1}`;
        chapters.push({
          id: `epub-ch-${i}`,
          title: chapterTitle,
          paragraphs,
          index: i + 1,
          totalCharacters: paragraphs.reduce((sum, p) => sum + p.text.length, 0),
        });
      }

      item.unload();
    } catch {
      // Skip items that fail to load
      continue;
    }
  }

  book.destroy();

  return { title, author, chapters };
}
