import ePub from 'epubjs';
import type { Chapter, Paragraph } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function extractEPub(
  file: File
): Promise<{ title: string; author?: string; chapters: Chapter[]; coverDataUrl?: string }> {
  const arrayBuffer = await file.arrayBuffer();

  // Un ePub es un ZIP: valida la firma PK\x03\x04 ANTES de dárselo a epubjs —
  // con un archivo que no es zip (descarga corrupta, .mobi renombrado, HTML de
  // una página de error) epubjs se queda colgado para siempre en book.ready y
  // la UI muere en "Procesando…" sin error.
  const magic = new Uint8Array(arrayBuffer.slice(0, 4));
  if (!(magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04)) {
    throw new Error('Invalid ePub: el archivo no es un ZIP válido (¿descarga corrupta o formato renombrado?)');
  }

  const book = ePub(arrayBuffer);

  // Wait for book to be fully loaded — con tope: si epubjs se atora con una
  // estructura interna rara, mejor un error accionable que un spinner eterno.
  await Promise.race([
    book.ready,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Invalid ePub: la estructura interna no se pudo leer (timeout)')), 30_000),
    ),
  ]);

  const title = book.packaging?.metadata?.title || file.name.replace(/\.epub$/i, '');
  const author = book.packaging?.metadata?.creator;

  const coverDataUrl = await extractCoverDataUrl(book);

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
    return { title, author, chapters, coverDataUrl };
  }

  // Recolecta párrafos crudos por si el spine no produce capítulos (edge
  // case: EPUB sin estructura de capítulos detectable) para armar un
  // capítulo único "Contenido" al final.
  const fallbackParagraphTexts: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item?.href) continue;

    try {
      // item.load() puede devolver un Document O un elemento suelto
      // (HTMLHtmlElement) según cómo epubjs parseó el capítulo — con
      // .html (no .xhtml) suele llegar el elemento, sin .body ni
      // .documentElement. Ambos soportan querySelectorAll/textContent.
      const doc: any = await item.load(book.load.bind(book));
      if (!doc) continue;

      const body = doc.body || doc.documentElement || (typeof doc.querySelectorAll === 'function' ? doc : null);
      if (!body) {
        item.unload?.();
        continue;
      }

      // El título se captura ANTES de podar, porque <title> vive en <head>
      const chapterTitle =
        doc.querySelector('h1, h2, h3, title')?.textContent?.trim() || `Capítulo ${i + 1}`;

      stripNonContent(doc);

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
        item.unload?.();
        continue;
      }

      fallbackParagraphTexts.push(...paraTexts);

      const paragraphs: Paragraph[] = paraTexts.map((paraText: string, j: number) => ({
        id: `epub-p-${i}-${j}`,
        text: paraText,
        chapterId: `epub-ch-${i}`,
      }));

      chapters.push({
        id: `epub-ch-${i}`,
        title: chapterTitle,
        paragraphs,
        index: i + 1,
        totalCharacters: paragraphs.reduce((sum, p) => sum + p.text.length, 0),
      });

      item.unload?.();
    } catch {
      // El item falló con el flujo normal (item.load) — intenta un
      // book.load directo sobre el href como último recurso para no
      // perder texto que sí existe en el archivo.
      try {
        const doc: any = await book.load(item.href);
        if (doc) {
          stripNonContent(doc);
          const body = doc.body || doc.documentElement || (typeof doc.querySelectorAll === 'function' ? doc : null);
          const text: string = body?.textContent || '';
          const texts = text
            .split(/\n+/)
            .map((p: string) => p.trim())
            .filter((p: string) => p.length > 2);
          fallbackParagraphTexts.push(...texts);
        }
      } catch {
        // Verdaderamente ilegible — se ignora.
      }
      continue;
    }
  }

  // Edge case: el spine se iteró pero no se detectaron capítulos
  // (chapters.length === 0), aunque sí se pudo extraer texto de algún
  // lado. El spec exige no perder ese contenido: se arma un capítulo
  // único "Contenido" con todos los párrafos recolectados.
  if (chapters.length === 0 && fallbackParagraphTexts.length > 0) {
    const paragraphs: Paragraph[] = fallbackParagraphTexts.map((paraText, j) => ({
      id: `epub-p-0-${j}`,
      text: paraText,
      chapterId: 'epub-ch-0',
    }));

    chapters.push({
      id: 'epub-ch-0',
      title: 'Contenido',
      paragraphs,
      index: 1,
      totalCharacters: paragraphs.reduce((sum, p) => sum + p.text.length, 0),
    });
  }

  book.destroy();
  return { title, author, chapters, coverDataUrl };
}

/**
 * Elimina nodos que no son contenido legible (CSS, JS, metadatos) para que
 * textContent y los selectores de párrafo no capturen reglas de estilo —
 * p.ej. "@page {padding: 0pt...}" aparecía como párrafo en portadas.
 * Acepta Document o elemento suelto (ambos soportan querySelectorAll).
 */
function stripNonContent(root: any): void {
  if (typeof root?.querySelectorAll !== 'function') return;
  try {
    root.querySelectorAll('style, script, head, link, meta, title').forEach((el: any) => el.remove?.());
  } catch {
    // Si el DOM parcial no soporta remove(), se deja tal cual.
  }
}

/**
 * Extrae la portada del ePub como dataURL JPEG reducido (~200px de ancho).
 * Intenta book.coverUrl() primero (blob URL de epubjs); si falla, busca en
 * el manifest el item con properties 'cover-image'. Libera el blob URL
 * generado en cualquier caso.
 */
async function extractCoverDataUrl(book: any): Promise<string | undefined> {
  let blobUrl: string | undefined;

  try {
    blobUrl = await book.coverUrl();

    if (!blobUrl) {
      // Fallback: busca en el manifest el item marcado como cover-image
      const manifest = book.packaging?.manifest;
      const coverItem = manifest
        ? Object.values(manifest).find((it: any) => it?.properties?.includes?.('cover-image'))
        : undefined;
      if (coverItem && typeof (coverItem as any).href === 'string') {
        const blob: Blob = await book.archive.getBlob((coverItem as any).href);
        blobUrl = URL.createObjectURL(blob);
      }
    }

    if (!blobUrl) return undefined;

    return await new Promise<string | undefined>((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = 200 / img.width;
          const canvas = document.createElement('canvas');
          canvas.width = 200;
          canvas.height = Math.round(img.height * scale) || 1;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(undefined);
            return;
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch {
          resolve(undefined);
        }
      };
      img.onerror = () => resolve(undefined);
      img.src = blobUrl as string;
    });
  } catch {
    return undefined;
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
}
