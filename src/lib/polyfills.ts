// Polyfills para Safari/iOS viejos (beta testers con iPhone sin actualizar).
//
// pdfjs-dist v6 usa Promise.withResolvers (ES2024, iOS/Safari 17.4+) tanto en
// la librería como en su worker; en iOS ≤17.3 la importación de un PDF muere
// con "undefined is not a function" al extraer texto. Este módulo debe
// importarse PRIMERO en main.tsx y en el wrapper del worker de pdf.js
// (src/workers/pdfjs-worker-entry.ts) para cubrir ambos contextos.

/* eslint-disable @typescript-eslint/no-explicit-any */

if (typeof (Promise as any).withResolvers !== 'function') {
  (Promise as any).withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// Safari/WebKit (incluso iOS 26) NO implementa la iteración asíncrona de
// ReadableStream (Symbol.asyncIterator); pdf.js v6 hace `for await (const v of
// readableStream)` dentro de getTextContent y la importación de CUALQUIER PDF
// muere en Safari con "undefined is not a function (near '...value of
// readableStream...')". Chrome/Firefox sí la traen — por eso el bug solo se ve
// en iPhone/Safari. Shim estándar sobre getReader().
if (
  typeof ReadableStream !== 'undefined' &&
  !(ReadableStream.prototype as any)[Symbol.asyncIterator]
) {
  (ReadableStream.prototype as any).values = function ({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      next() {
        return reader.read();
      },
      async return(value: unknown) {
        if (!preventCancel) await reader.cancel();
        reader.releaseLock();
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  (ReadableStream.prototype as any)[Symbol.asyncIterator] = (ReadableStream.prototype as any).values;
}

export {};
