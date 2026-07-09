# 📖 TSS Reader App

PWA que convierte PDFs y ePubs en audiolibros con síntesis de voz (TTS) y seguimiento visual palabra-por-palabra — estilo Speechify.

## ✨ Features

- **Importar PDF y ePub** — arrastra el archivo o selecciónalo desde tu dispositivo
- **TTS con Edge TTS** — voces naturales de Microsoft (gratuito)
- **Karaoke visual** — resalta la palabra activa mientras suena el audio
- **3 voces femeninas** — Dalia (es-MX), Elvira (es-ES), Aria (en-US)
- **Control de velocidad** — de 0.5x a 2.0x
- **Prefetch inteligente** — pre-genera los próximos párrafos en background
- **Cache offline** — 3 capas (memoria → IndexedDB → Cloudflare R2)
- **PWA instalable** — funciona en iOS, Mac y Android
- **Dark/light mode** — se adapta al tema del sistema

## 🏗️ Arquitectura

```
┌─────────────────────────────────────────────────────┐
│                  PWA (React + Vite)                  │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────┐ │
│  │EXTRACTOR │─▶│ CHUNKER  │─▶│ TTS      │─▶│PLAYER│ │
│  │pdf.js    │  │ split    │  │ CLIENT   │  │Audio │ │
│  │epub.js   │  │ párrafos │  │ fetch    │  │+rAF  │ │
│  └──────────┘  └──────────┘  └────┬─────┘  └──────┘ │
│                                   │                   │
│  ┌────────────────┐  ┌───────────▼───────────┐       │
│  │ CACHE 3-tier   │  │ 3 Stores Zustand      │       │
│  │ LRU→IndexedDB  │  │ Document/Playback/    │       │
│  └────────────────┘  │ Cache                  │       │
│                       └───────────────────────┘       │
└───────────────────────┬─────────────────────────────┘
                        │
             ┌──────────▼──────────┐
             │  Cloudflare Worker  │
             │  POST /tts          │
             │  Edge TTS + R2      │
             └─────────────────────┘
```

### Pipeline de 4 agentes

| Agente | Dónde corre | Qué hace |
|---|---|---|
| **Extractor** | Client-side | Parsea PDF/ePub → texto estructurado |
| **Chunker** | Client-side | Divide en chunks de ~500 chars por oración |
| **TTS Client** | Client-side → Worker | Fetch audio + word timestamps, con cache |
| **Player** | Client-side | Web Audio API + requestAnimationFrame para karaoke |

### Tech Stack

- **Frontend:** React 19 + Vite + TypeScript
- **Estado:** Zustand (3 stores)
- **PDF parsing:** pdf.js (pdfjs-dist)
- **ePub parsing:** epubjs
- **Audio:** Web Audio API + AudioContext
- **Storage:** IndexedDB (idb-keyval) + LRU memory
- **Backend:** Cloudflare Workers + R2
- **TTS:** Microsoft Edge TTS (gratuito, sin API key)
- **PWA:** vite-plugin-pwa

## 🚀 Instalación

### Prerrequisitos

- Node.js 18+
- npm o pnpm
- Cuenta de Cloudflare (para deploy del Worker)

### 1. Clonar

```bash
git clone https://github.com/ernestodisa/tss-reader-app.git
cd tss-reader-app
```

### 2. Instalar dependencias del frontend

```bash
npm install
```

### 3. Instalar dependencias del Worker

```bash
cd worker
npm install
cd ..
```

### 4. Configurar entorno

```bash
cp .env.example .env
# Editar .env con la URL del Worker (ver paso 5)
```

### 5. Deploy del Cloudflare Worker

```bash
cd worker

# Crear bucket R2 para cache
npx wrangler r2 bucket create speechify-tts-cache

# Deploy del Worker
npx wrangler deploy
```

Anota la URL del Worker (ej: `https://speechify-tts.tu-subdomain.workers.dev`) y ponla en `.env`:

```
VITE_WORKER_URL=https://speechify-tts.tu-subdomain.workers.dev
```

### 6. Ejecutar en desarrollo

```bash
# Terminal 1 — Worker local
cd worker
npx wrangler dev --local

# Terminal 2 — Frontend
npm run dev
```

Abre http://localhost:5173

### 7. Deploy de producción

```bash
npm run build
npx wrangler pages deploy dist --project-name tss-reader-app
```

## 📱 Uso

1. Abre la app en tu navegador (o instálala como PWA)
2. Arrastra un PDF o ePub
3. Selecciona voz y velocidad
4. Presiona ▶ para empezar a escuchar
5. La palabra activa se resalta automáticamente mientras escuchas

### Instalar como app

- **iOS Safari:** Compartir → "Añadir a pantalla de inicio"
- **Mac Safari:** Archivo → "Añadir al Dock"
- **Android Chrome:** Menú → "Instalar app"

## 🗂️ Estructura del proyecto

```
src/
├── agents/          # Pipeline de agentes (extractor, chunker, tts-client, player)
├── components/       # 7 componentes UI de React
├── hooks/           # Hooks que desacoplan UI de stores
├── store/           # 3 stores Zustand (document, playback, cache, library)
├── lib/             # Utils (hash, tokenizer, cache, audio, prefetch)
├── types/           # Tipos centralizados de todo el dominio
├── workers/         # Web Worker para parseo off-main-thread
└── styles/          # CSS global con dark/light theme

worker/
└── src/             # Cloudflare Worker (Edge TTS + R2 cache)
```

## 🎤 Voces disponibles

| Voz | Idioma | ID |
|---|---|---|
| Dalia | Español (México) | `es-MX-DaliaNeural` |
| Elvira | Español (España) | `es-ES-ElviraNeural` |
| Aria | Inglés (EE.UU.) | `en-US-AriaNeural` |

## 📝 Roadmap (post-MVP)

- [ ] Continuar donde dejaste (bookmark automático)
- [ ] Visualización completa del libro con párrafos clickeables
- [ ] Media Session API (controles desde pantalla de bloqueo)
- [ ] Gestión de biblioteca con portadas
- [ ] Múltiples motores TTS (ElevenLabs, OpenAI)
- [ ] Exportar audio como MP3
- [ ] Salto por capítulo
- [ ] Notas y marcadores
- [ ] Sincronizar progreso entre dispositivos

## 📄 Licencia

MIT

## 🔗 Links

- [Spec de diseño](docs/specs/2026-07-09-speechify-clone-design.md)
- [Plan de implementación](docs/superpowers/plans/2026-07-09-speechify-clone.md)
- [Guía de deploy](DEPLOYMENT.md)
