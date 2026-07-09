import ePub from 'epubjs';
import type { Chapter, Paragraph } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function extractEPub(file: File): Promise<{ title: string; author?: string; chapters: Chapter[] }> {
  const arrayBuffer = await file.arrayBuffer();
  const book = ePub(arrayBuffer);

  // Wait for book to be fully loaded
  await book.ready;

  const title = book.packaging?.metadata?.title || file.name.replace(/\.epub$/i, '');
  const author = book.packaging?.metadata?.creator;

  const chapters: Chapter[] = [];

  // epubjs types are incomplete — cast spine to access spineItems array
  const spine: any = book.spine;
  let items: any[] = spine.spineItems || [];

  // Fallback: try each() method if spineItems is empty
  if (items.length === 0 && typeof spine.each === 'function') {
    const collected: any[] = [];
    spine.each((item: any) => collected.push(item));
    items = collected;
  }

  if (items.length === 0) {
    book.destroy();
    return { title, author, chapters };
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item?.href) continue;

    try {
      // item.load() returns a Promise<Document>
      const doc: Document = await item.load(book.load.bind(book));
      if (!doc) continue;

      const body = doc.body || doc.documentElement;
      if (!body) {
        item.unload();
        continue;
      }

      // Try to extract paragraphs from <p> tags first
      const paraElements = doc.querySelectorAll('p, div, h1, h2, h3');
      let paraTexts: string[];

      if (paraElements.length > 1) {
        paraTexts = [];
        paraElements.forEach((el: any) => {
          const t = el?.textContent?.trim();
          if (t && t.length > 2) paraTexts.push(t);
        });
      } else {
        // Fallback: get all text and split by newlines
        const text = body.textContent || '';
        paraTexts = text
          .split(/\n+/)
          .map((p: string) => p.trim())
          .filter((p: string) => p.length > 2);
      }

      if (paraTexts.length === 0) {
        item.unload();
        continue;
      }

      const paragraphs: Paragraph[] = paraTexts.map((paraText: string, j: number) => ({
        id: `epub-p-${i}-${j}`,
        text: paraText,
        chapterId: `epub-ch-${i}`,
      }));

      const chapterTitle = doc.querySelector('h1, h2, h3, title')?.textContent?.trim() || `Capítulo ${i + 1}`;

      chapters.push({
        id: `epub-ch-${i}`,
        title: chapterTitle,
        paragraphs,
        index: i + 1,
        totalCharacters: paragraphs.reduce((sum, p) => sum + p.text.length, 0),
      });

      item.unload();
    } catch {
      // Skip items that fail to load
      continue;
    }
  }

  book.destroy();
  return { title, author, chapters };
}
