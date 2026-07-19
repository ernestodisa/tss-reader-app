/// <reference lib="webworker" />
// Wrapper del worker de pdf.js: aplica los polyfills (Promise.withResolvers en
// iOS ≤17.3) ANTES de cargar el worker real. GlobalWorkerOptions.workerSrc
// apunta aquí (ver src/lib/pdf-utils.ts) — sin este wrapper, el worker de
// pdf.js truena en Safari viejo aunque el hilo principal esté polyfilleado.
import '../lib/polyfills';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
