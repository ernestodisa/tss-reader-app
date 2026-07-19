import { extractPDF } from '../lib/pdf-utils';
import { extractEPub } from '../lib/epub-utils';
import type { AgentResult, ExtractedDoc, PipelineError } from '../types';

export async function extractDocument(file: File): Promise<AgentResult<ExtractedDoc>> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const isEpub = file.type === 'application/epub+zip' || file.name.toLowerCase().endsWith('.epub');

  if (!isPdf && !isEpub) {
    return {
      success: false,
      error: {
        step: 'extract',
        code: 'unsupported_format',
        message: `Formato no soportado: ${file.type || file.name}. Solo PDF y ePub.`,
        recoverable: false,
      },
    };
  }

  try {
    const raw = isPdf
      ? await extractPDF(file)
      : await extractEPub(file);

    const totalCharacters = raw.chapters.reduce(
      (sum, ch) => sum + ch.totalCharacters, 0
    );

    const totalPages = isPdf
      ? (raw as unknown as { totalPages: number }).totalPages
      : undefined;

    const coverDataUrl = isPdf
      ? undefined
      : (raw as unknown as { coverDataUrl?: string }).coverDataUrl;

    const doc: ExtractedDoc = {
      title: raw.title,
      author: raw.author,
      chapters: raw.chapters,
      sourceType: isPdf ? 'pdf' : 'epub',
      totalPages,
      totalCharacters,
      estimatedDurationMs: Math.round(totalCharacters / 15 * 1000), // ~15 chars/sec at 1x
      coverDataUrl,
    };

    return { success: true, data: doc };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error';
    const isCorrupt = message.includes('password') || message.includes('Invalid') || message.includes('corrupt');

    // Diagnóstico de campo: el mensaje corto ("undefined is not a function")
    // no dice DÓNDE tronó. El primer frame del stack apunta a la librería
    // culpable (epubjs/pdfjs) y el log completo queda en consola para
    // recuperarlo con el iPhone conectado a Safari de Mac si hace falta.
    const frame =
      err instanceof Error && err.stack
        ? (err.stack.split('\n').find((l) => l.trim() && !l.includes(message)) ?? '').trim().slice(0, 120)
        : '';
    console.error('[extractor] fallo de extracción', { file: file.name, size: file.size, type: file.type, err });

    const error: PipelineError = {
      step: 'extract',
      code: isCorrupt ? 'corrupt_file' : 'extraction_failed',
      message: isCorrupt
        ? 'El archivo está corrupto o protegido con contraseña.'
        : `Error al extraer texto: ${message}${frame ? ` [${frame}]` : ''}`,
      recoverable: false,
    };

    return { success: false, error };
  }
}