import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // A7 — dev same-origin: el frontend habla SIEMPRE con `/api/*` (igual que en
  // producción, donde la Pages Function sirve ese prefijo). En dev, este proxy
  // reenvía `/api/*` al worker local (`wrangler dev`, puerto 8787) quitando el
  // prefijo `/api`, replicando EXACTAMENTE el rewrite de functions/api/[[path]].ts
  // (`url.pathname.replace(/^\/api/, '') || '/'`). Así desaparece el CORS del
  // cuadro: nunca hay request cross-origin y `credentials: 'include'` viaja sin
  // el conflicto ACAO '*' + Allow-Credentials. La identidad en dev la resuelve
  // el worker vía DEV_FAKE_EMAIL (worker/.dev.vars, ver .dev.vars.example).
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '') || '/',
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      // 'prompt': el SW nuevo NO espera al doble-reinicio — la UI avisa
      // (UpdateToast) y un toque actualiza. Ver src/lib/sw-update.ts.
      registerType: 'prompt',
      manifest: {
        name: 'Folio — audiolector',
        short_name: 'Folio',
        display: 'standalone',
        background_color: '#151312',
        theme_color: '#151312',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  worker: {
    format: 'es',
  },
})
