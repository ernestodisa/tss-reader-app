import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Chapter, Paragraph } from '../types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export async function extractPDF(file: File): Promise<{ title: string; author?: string; chapters: Chapter[]; totalPages: number }> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const meta = await pdf.getMetadata().catch(() => null);
  const info = meta?.info as Record<string, string> | undefined;
  const title = info?.Title || file.name.replace(/\.pdf$/i, '');
  const author = info?.Author;

  const chapters: Chapter[] = [];
  let globalParaCounter = 0;

  // Simple extraction: each page is a "chapter" for PDFs without TOC
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // Reconstruct paragraphs from text items
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawItems = content.items as any[];
    const textItems = rawItems
      .filter((item: any) => 'str' in item && item.transform)
      .map((item: any) => ({
        str: item.str as string,
        y: item.transform[5] as number,
        x: item.transform[4] as number,
      }));

    const paragraphs = groupIntoParagraphs(textItems, pageNum, globalParaCounter);
    globalParaCounter += paragraphs.length;

    if (paragraphs.length > 0) {
      chapters.push({
        id: `pdf-ch-${pageNum}`,
        title: `Página ${pageNum}`,
        paragraphs,
        index: pageNum,
        totalCharacters: paragraphs.reduce((sum, p) => sum + p.text.length, 0),
      });
    }
  }

  return { title, author, chapters, totalPages: pdf.numPages };
}

interface TextItem {
  str: string;
  y: number;
  x: number;
}

function groupIntoParagraphs(items: TextItem[], page: number, startCounter: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let currentText = '';
  let lastY: number | null = null;
  const LINE_HEIGHT_THRESHOLD = 5; // pixels

  for (const item of items) {
    if (lastY !== null && Math.abs(item.y - lastY) > LINE_HEIGHT_THRESHOLD) {
      // New line — check if paragraph break
      if (currentText.trim()) {
        // Heuristic: if line ended with sentence terminator, new paragraph
        if (/[.!?]\s*$/.test(currentText.trim())) {
          paragraphs.push({
            id: `pdf-p-${page}-${startCounter + paragraphs.length}`,
            text: currentText.trim(),
            chapterId: `pdf-ch-${page}`,
            page,
          });
          currentText = '';
        }
      }
    }
    currentText += item.str;
    lastY = item.y;
  }

  if (currentText.trim()) {
    paragraphs.push({
      id: `pdf-p-${page}-${startCounter + paragraphs.length}`,
      text: currentText.trim(),
      chapterId: `pdf-ch-${page}`,
      page,
    });
  }

  return paragraphs;
}