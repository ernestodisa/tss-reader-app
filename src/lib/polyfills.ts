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
    let released = false;
    // B6: libera el lock una sola vez, sea por fin normal o por return().
    const release = () => {
      if (released) return;
      released = true;
      try {
        reader.releaseLock();
      } catch {
        // ya liberado
      }
    };
    return {
      async next() {
        const result = await reader.read();
        // B6: al terminar la iteración normal (done: true) también hay que
        // soltar el lock — antes solo lo hacía return() (salida anticipada),
        // así que una iteración que se agotaba dejaba el stream bloqueado.
        if (result.done) release();
        return result;
      },
      async return(value: unknown) {
        if (!preventCancel) {
          try {
            await reader.cancel();
          } catch {
            // el reader pudo quedar sin lock si ya terminó por next()
          }
        }
        release();
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  (ReadableStream.prototype as any)[Symbol.asyncIterator] = (ReadableStream.prototype as any).values;
}

// pdfjs-dist 6.1.200 usa Map.prototype.getOrInsertComputed (propuesta TC39
// "upsert", solo Safari 26+/Chrome muy reciente) SIN feature-detect — p.ej.
// `this._intentStates.getOrInsertComputed(...)` y en getMetadata. En iOS 18.x
// la importación de CUALQUIER PDF muere con "getOrInsertComputed is not a
// function" (visto en campo en iOS 18.7.9, 2026-07-22). Se polyfillean las dos
// variantes de la propuesta en Map y WeakMap.
for (const ctor of [Map, WeakMap] as any[]) {
  const proto = ctor.prototype;
  if (typeof proto.getOrInsert !== 'function') {
    proto.getOrInsert = function (key: unknown, defaultValue: unknown) {
      if (this.has(key)) return this.get(key);
      this.set(key, defaultValue);
      return defaultValue;
    };
  }
  if (typeof proto.getOrInsertComputed !== 'function') {
    proto.getOrInsertComputed = function (key: unknown, callback: (k: unknown) => unknown) {
      if (this.has(key)) return this.get(key);
      const value = callback(key);
      this.set(key, value);
      return value;
    };
  }
}

// pdfjs-dist v6 también llama Promise.try (Safari/iOS 18.2+) sin guard. El
// iPhone de campo (18.7.9) sí lo trae, pero iOS 17.x-18.1 no — mismo destino
// que withResolvers, así que se cubre de una vez.
if (typeof (Promise as any).try !== 'function') {
  (Promise as any).try = function tryFn(fn: (...a: unknown[]) => unknown, ...args: unknown[]) {
    return new Promise((resolve) => resolve(fn(...args)));
  };
}

export {};
