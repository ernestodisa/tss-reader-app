// PRIMERO los polyfills (Promise.withResolvers para iOS ≤17.3 — sin esto la
// importación de PDFs muere en Safari viejo), luego la migración de re-branding.
import './lib/polyfills';
// La migración de re-branding: renombra llaves localStorage
// speechify-* → folio-* de forma síncrona ANTES de que los stores (zustand
// persist) lean las suyas al importarse.
import { migrateIdbToFolio } from './lib/rebrand-migration';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import { initAutoSync } from './lib/auto-sync';
import { idbCacheStore } from './lib/indexeddb-cache';
import { docsStore } from './lib/library-docs';

// Migra IndexedDB (cache TTS + contenidos de libros) al namespace nuevo. NO
// bloquea el primer render (M14): corre EN PARALELO y los dos puntos de lectura
// inicial de IDB (library-docs.loadDoc y IndexedDBCache.get) esperan
// `migrationReady` antes de leer, para no ver un libro "sin contenido" durante
// la copia. Un timeout de seguridad (dentro de migrationReady) evita que un
// indexedDB.open colgado (Safari) deje la app muerta. Una sola vez; sin datos
// viejos es un no-op casi instantáneo.
migrateIdbToFolio(idbCacheStore, docsStore).catch((e) =>
  console.error('[rebrand-migration] migración IDB falló:', e),
);

// Arranca la sincronización automática por identidad (Access). Es idempotente y
// silenciosa: si no hay sesión o red, la app sigue funcionando offline.
initAutoSync();

// Registro del service worker en modo prompt: la UI avisa cuando hay versión
// nueva (UpdateToast) en vez del doble-reinicio a ciegas.
import { initSwUpdate } from './lib/sw-update';
initSwUpdate();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
