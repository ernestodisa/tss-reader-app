import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import { initAutoSync } from './lib/auto-sync';

// Arranca la sincronización automática por identidad (Access). Es idempotente y
// silenciosa: si no hay sesión o red, la app sigue funcionando offline.
initAutoSync();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
