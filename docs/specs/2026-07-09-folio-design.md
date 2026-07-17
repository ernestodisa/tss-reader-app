# Speechify Clone — Design Spec

> **Proyecto:** App PWA para leer PDF/ePub como audiolibros con TTS y seguimiento visual palabra-por-palabra (karaoke).
> **Fecha:** 2026-07-09
> **Autor:** Ernesto Rodríguez (con Hermes Agent)

---

## 1. Objetivo

Construir un clon de Speechify enfocado en su capacidad central: TTS para leer PDF y ePub como audiolibros, con seguimiento visual palabra-por-palabra mientras se escucha. PWA instalable en iOS y Mac.

---

## 2. Decisiones Arquitectónicas

Todas las decisiones se tomaron como Opción A (recomendada). Se documentan las alternativas consideradas para explorar ajustes durante pruebas.

| # | Decisión | Elegida | Alternativas consideradas |
|---|---|---|---|
| D1 | Framework Frontend | **React + Vite** — ecosistema maduro, react-pdf, vite-plugin-pwa | Svelte+Vite (bundle menor, menos libs), Vanilla TS+WC (máximo control, más tiempo) |
| D2 | TTS + Timing | **SSML + Word Boundary events nativos de Edge TTS** — timing preciso sin post-procesamiento | Forced Alignment con whisper.cpp (más preciso, +2-5s latencia), Web Speech API nativa (gratis pero calidad inferior) |
| D3 | Karaoke visual | **DOM directo con spans por palabra** — simple, accesible, seleccionable | Canvas overlay (pierde selección de texto), CSS Custom Properties + Web Animations API (sincronización frágil) |
| D4 | Audio/chunking | **Cola con prefetch predictivo** — gapless playback, pre-genera N+1 y N+2 | Generar todo el libro (espera muy larga), streaming sin prefetch (gaps entre párrafos) |
| D5 | Parseo documentos | **Client-side con pdf.js + epub.js** — sin subir archivos, privado | Server-side con Python (mejor extracción pero requiere VPS), Híbrido (dos code paths) |
| D6 | Cache | **IndexedDB + LRU memoria** — persistente, sin costo server | CF R2 server-side (costo, latencia red), sin cache (regenerar siempre) |
| D7 | Multiagente | **Pipeline de agentes especializados** — cada agente con responsabilidad clara | Orquestador server-side con cola (menos flexibilidad), monolito (acoplado) |
| D8 | Deploy | **Cloudflare Pages + CF Worker** — gratis, CDN global | Vercel (límites más estrictos), VPS self-hosted ($5-20/mes) |

### Notas para explorar en pruebas

- **D2:** Si Edge TTS word boundaries resultan imprecisos (±>100ms), explorar Forced Alignment como fallback.
- **D3:** Si el rendimiento de spans por palabra es pobre en párrafos largos, evaluar renderizar solo el párrafo activo o virtualizar.
- **D4:** Si la latencia de red del Worker causa gaps, aumentar ventana de prefetch de 2 a 3 chunks.
- **D5:** Si pdf.js falla en PDFs complejos/escaneados, considerar server-side fallback con OCR.
- **D6:** Si IndexedDB se llena rápido, implementar política de evicción LRU por tamaño (ej: max 500MB).

---

## 3. Arquitectura

### 3.1 Diagrama

```
┌─────────────────────────────────────────────────────────────┐
│                    PWA (React + Vite)                        │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐ │
│  │EXTRACTOR │─▶│ CHUNKER  │─▶│ TTS      │─▶│ PLAYER      │ │
│  │pdf.js    │  │ split    │  │ CLIENT   │  │ Web Audio   │ │
│  │epub.js   │  │ párrafos │  │ fetch    │  │ rAF karaoke │ │
│  └──────────┘  └──────────┘  └────┬─────┘  └─────────────┘ │
│                                   │                          │
│  ┌────────────────┐  ┌───────────▼───────────┐              │
│  │ CACHE LAYER    │  │ STATE (3 stores)      │              │
│  │ LRU → IndexedDB│  │ Document / Playback / │              │
│  │                │  │ Cache                 │              │
│  └────────────────┘  └───────────────────────┘              │
│                                                              │
└────────────────────────────┬────────────────────────────────┘
                             │
                  ┌──────────▼──────────┐
                  │  CF WORKER (API)    │
                  │  POST /tts          │
                  │  Edge TTS proxy     │
                  │  + word boundaries  │
                  │  + cache R2         │
                  └─────────────────────┘
```

### 3.2 Agentes del Pipeline

| Agente | Dónde corre | Responsabilidad | Tech |
|---|---|---|---|
| **Extractor** | Client-side (Web Worker) | Parsear PDF/ePub → `ExtractedDoc` con capítulos, párrafos, metadatos | pdf.js, epub.js |
| **Chunker** | Client-side | Dividir párrafos en chunks de ~500 chars respetando fronteras de oración. Producir `ChunkPlan` con `paragraphId` y mapeo de palabras | TS puro |
| **TTS Client** | Client-side → CF Worker | Enviar chunk al Worker, recibir audio + word timings. Gestionar cache L1/L2 | fetch API |
| **Player** | Client-side | `AudioContext`, scheduling de buffers, `requestAnimationFrame` para karaoke tracking, prefetch | Web Audio API |

### 3.3 State Management — 3 stores Zustand

El agente-juez identificó que un solo store God object es anti-pattern. Se divide en 3 stores independientes:

**DocumentStore** — qué estamos leyendo
- `doc: ExtractedDoc | null`
- `isLoading: boolean`
- `error: string | null`
- `loadDocument(file: File): Promise<void>`
- `unloadDocument(): void`

**PlaybackStore** — cómo lo estamos leyendo
- `chapterIndex`, `paragraphIndex`, `wordIndex`, `positionMs`
- `isPlaying`, `isBuffering`
- `voiceId`, `speed`, `generationId` (para invalidar prefetch)
- `wordTimings: Map<string, WordTiming[]>`
- `timingsStatus: Map<string, TimingStatus>`
- `play()`, `pause()`, `stop()`, `seekToWord()`, `setVoice()`, `setSpeed()`

**CacheStore** — infraestructura
- `stats: { hits, misses, sizeBytes }`
- `getAudio(key)`, `putAudio(key, buffer)`
- `getTimings(key)`, `putTimings(key, timings)`
- `evict()`, `clear()`

### 3.4 Capa de Hooks (desacople UI ↔ Store)

Los componentes NO importan stores directamente. Usan hooks intermedios:

| Hook | Retorna | Uso |
|---|---|---|
| `useDocument()` | `{ doc, isLoading, error, loadDocument }` | Library, ImportDropzone, ReaderView |
| `usePlayback()` | `{ isPlaying, positionMs, voiceId, speed, play, pause, ... }` | PlayerBar, VoiceSelector, SpeedControl |
| `useKaraoke(paragraphId)` | `{ wordIndex, isActive, timings }` | KaraokeText |
| `useLibrary()` | `{ books, addBook, removeBook }` | Library |

---

## 4. Tipos y Contratos

### 4.1 Tipos de Documento (`src/types/document.ts`)

```typescript
interface ExtractedDoc {
  title: string;
  author?: string;
  chapters: Chapter[];
  sourceType: 'pdf' | 'epub';
  language?: string;
  totalPages?: number;
  totalCharacters: number;
  estimatedDurationMs?: number;
  coverImage?: ArrayBuffer;
  metadata?: Record<string, string>;
}

interface Chapter {
  id: string;
  title: string;
  paragraphs: Paragraph[];
  index: number;                  // 1-based
  totalCharacters: number;
  estimatedDurationMs?: number;
}

interface Paragraph {
  id: string;
  text: string;
  chapterId: string;
  page?: number;                  // solo PDF
}

interface TokenPosition {
  wordIndex: number;              // 0-based en párrafo
  charStart: number;
  charEnd: number;
}
```

> **Nota del agente-juez (Issue #1):** `Paragraph` ya NO tiene `words?: WordToken[]`. Los timings de TTS se almacenan separados en `PlaybackStore.wordTimings` para mantener el documento de extracción inmutable.

### 4.2 Tipos de Chunking (`src/types/chunk.ts`)

```typescript
interface TTSChunk {
  id: string;                     // hash(text + voiceId + speed)
  paragraphId: string;
  chunkIndex: number;             // 0, 1, 2 dentro del párrafo
  text: string;
  voiceId: string;
  speed: number;
}

interface ChunkJob {
  paragraphId: string;
  paragraphText: string;
  voiceId: string;
  speed: number;
  maxChunkChars: number;          // default 500
  strategy: 'sentence' | 'fixed' | 'paragraph';
}

interface ChunkPlan {
  paragraphId: string;
  chunks: TTSChunk[];
  estimatedDurationMs: number;
  wordOffsetMap: Map<number, number>; // wordIndex global del párrafo → chunkIndex local
}
```

### 4.3 Tipos de TTS (`src/types/tts.ts`)

```typescript
interface WordTiming {
  wordIndex: number;              // mapea a TokenPosition.wordIndex
  text: string;
  offsetMs: number;
  durationMs: number;
}

interface TTSResponse {
  chunkId: string;
  audio: ArrayBuffer;
  format: 'mp3' | 'ogg';
  words: WordTiming[];
  durationMs: number;
}

interface VoiceConfig {
  id: string;
  name: string;
  language: string;
  gender?: string;
  engine: 'edge' | 'elevenlabs' | 'openai' | 'playht';
  sampleRate?: number;
}
```

### 4.4 Tipos de Error (`src/types/errors.ts`)

```typescript
type PipelineStep = 'extract' | 'chunk' | 'tts' | 'play';

interface PipelineError {
  step: PipelineStep;
  paragraphId?: string;
  chunkId?: string;
  code: string;
  message: string;
  recoverable: boolean;
  retryAfterMs?: number;
}

type AgentResult<T> =
  | { success: true; data: T }
  | { success: false; error: PipelineError };
```

> **Todos los agentes retornan `AgentResult<T>`, nunca throw crudo.**

### 4.5 Tipos de Cache (`src/types/cache.ts`)

```typescript
type CacheKey = `${string}:${string}`; // "audio:<chunkId>" | "timings:<paragraphId>"

interface CacheEntry<T> {
  key: CacheKey;
  value: T;
  createdAt: number;
  lastAccessedAt: number;
  sizeBytes: number;
  ttlMs: number;
}

interface CacheLayer {
  get<T>(key: CacheKey): Promise<CacheEntry<T> | null>;
  put<T>(key: CacheKey, value: T, ttlMs: number): Promise<void>;
  delete(key: CacheKey): Promise<void>;
  clear(): Promise<void>;
  stats(): CacheStats;
}

// Implementaciones: MemoryCache (L1), IndexedDBCache (L2), TieredCache (facade)
```

### 4.6 TimingStatus (estado de timings por párrafo)

```typescript
type TimingStatus =
  | { status: 'idle' }
  | { status: 'fetching' }
  | { status: 'ready'; timings: WordTiming[] }
  | { status: 'error'; error: PipelineError };
```

> **Resuelve Issue #7:** distingue "no fetcheado" vs "fetcheando" vs "ready" vs "error".

---

## 5. Player Agent — Interfaz

El agente-juez (Issue #6) identificó frontera borrosa entre `agents/player.ts` y `components/PlayerBar.tsx`. Se clarifica:

| Concern | Owner |
|---|---|
| `AudioContext` lifecycle | `agents/player.ts` |
| Audio buffer scheduling | `agents/player.ts` |
| `requestAnimationFrame` word tracking | `agents/player.ts` |
| Play/pause/seek buttons | `components/PlayerBar.tsx` |
| Progress bar | `components/PlayerBar.tsx` |
| Voice selector | `components/VoiceSelector.tsx` |

```typescript
interface PlayerAgent {
  load(paragraphId: string, audio: AudioBuffer, timings: WordTiming[]): void;
  play(): void;
  pause(): void;
  stop(): void;
  seek(wordIndex: number): void;
  destroy(): void;
  // Hook para que KaraokeText se suscriba al word activo
  useActiveWord(): { wordIndex: number; positionMs: number };
}
```

---

## 6. Prefetch — Invalición por generationId

> **Issue #5 del agente-juez:** cambiar voz/velocidad no limpia la cola de prefetch.

**Solución:** `generationId` (counter monotónico) en PlaybackStore. Se incrementa en cualquier cambio de voz, velocidad o seek. Todos los requests de prefetch llevan el `generationId` actual. Si al responder el `generationId` cambió, el resultado se descarta.

```typescript
// En playback store:
generationId: number;  // bumped on voice/speed/seek change

// En prefetch:
const gen = usePlaybackStore.getState().generationId;
const result = await fetchChunk(chunkId);
if (usePlaybackStore.getState().generationId !== gen) {
  return; // stale, discard
}
```

---

## 7. Cloudflare Worker — API

### Endpoint

```
POST /tts
Content-Type: application/json

Request:
{
  "text": "El análisis de los resultados...",
  "voiceId": "es-MX-DaliaNeural",
  "speed": 1.0,
  "format": "mp3"
}

Response 200 (binary):
  audio: ArrayBuffer (MP3)
  X-Chunk-Id: <hash>
  X-Words: <JSON array of WordTiming>
  X-Duration: <ms>

Response 200 (from R2 cache):
  Mismo formato, servido en <50ms

Response 429:
  { "error": "rate_limited", "retryAfterMs": 1000 }

Response 500:
  { "error": "tts_failed", "message": "..." }
```

### Cache en R2

- Key: `tts:<chunkId>` (hash de text + voiceId + speed)
- TTL: 30 días
- Si el chunk ya existe en R2, se sirve directo sin llamar a Edge TTS

### Multi-engine hook

`worker/src/multi-engine.ts` tiene un router que por defecto envía a Edge TTS, pero deja hooks para añadir ElevenLabs, OpenAI, etc. sin cambiar el endpoint:

```typescript
type Engine = 'edge' | 'elevenlabs' | 'openai';

const engines: Record<Engine, TTSEngine> = {
  edge: edgeTTS,
  // elevenlabs: elevenLabsTTS,  // futuro
  // openai: openaiTTS,          // futuro
};

interface TTSEngine {
  synthesize(text: string, voiceId: string, speed: number): Promise<{
    audio: ArrayBuffer;
    words: WordTiming[];
    durationMs: number;
  }>;
}
```

---

## 8. Voces Disponibles (MVP)

Solo voces femeninas:

| Voz | Idioma | Voice ID |
|---|---|---|
| Dalia | es-MX | `es-MX-DaliaNeural` |
| Elvira | es-ES | `es-ES-ElviraNeural` |
| Aria | en-US | `en-US-AriaNeural` |

---

## 9. Estructura de Archivos (revisada por agente-juez)

```
speechify-clone/
├── src/
│   ├── types/                          # Contratos centralizados
│   │   ├── document.ts
│   │   ├── chunk.ts
│   │   ├── tts.ts
│   │   ├── player.ts
│   │   ├── errors.ts
│   │   └── cache.ts
│   │
│   ├── agents/                         # Agentes no-visuales con APIs programáticas
│   │   ├── extractor.ts               # File → ExtractedDoc (vía Web Worker)
│   │   ├── chunker.ts                 # Paragraph → ChunkPlan
│   │   ├── tts-client.ts              # ChunkPlan → TTSResponse[] (fetch + cache)
│   │   ├── player.ts                  # AudioContext, scheduling, rAF karaoke
│   │   └── types.ts                   # AgentResult<T>, Pipeline interfaces
│   │
│   ├── hooks/                          # Capa entre componentes y stores
│   │   ├── useDocument.ts
│   │   ├── usePlayback.ts
│   │   ├── useLibrary.ts
│   │   └── useKaraoke.ts
│   │
│   ├── store/                          # Zustand — 3 stores separados
│   │   ├── document-store.ts
│   │   ├── playback-store.ts
│   │   ├── cache-store.ts
│   │   └── library-store.ts
│   │
│   ├── components/                     # UI pura — sin AudioContext, sin fetch
│   │   ├── Library.tsx
│   │   ├── ImportDropzone.tsx
│   │   ├── ReaderView.tsx
│   │   ├── KaraokeText.tsx            # Lee useKaraoke() hook
│   │   ├── PlayerBar.tsx              # Lee usePlayback() hook
│   │   ├── VoiceSelector.tsx
│   │   └── SpeedControl.tsx
│   │
│   ├── lib/                            # Utils puras
│   │   ├── audio-utils.ts             # crossfade, gapless, time math
│   │   ├── pdf-utils.ts
│   │   ├── epub-utils.ts
│   │   ├── hash.ts                    # cache keys
│   │   └── tokenizer.ts              # word tokenization para extracción
│   │
│   ├── workers/                        # Web Workers (no confundir con CF Worker)
│   │   └── extract-worker.ts          # parseo pesado off-main-thread
│   │
│   ├── App.tsx
│   └── main.tsx
│
├── worker/                             # Cloudflare Worker (API backend)
│   ├── src/
│   │   ├── index.ts                   # Router endpoint /tts
│   │   ├── edge-tts.ts               # Proxy a Edge TTS
│   │   ├── ssml-builder.ts           # SSML con boundary markers
│   │   ├── r2-cache.ts               # Cache en Cloudflare R2
│   │   ├── multi-engine.ts           # Router multi-motor (hooks futuros)
│   │   └── types.ts                  # Tipos del lado del worker
│   └── wrangler.toml
│
├── public/
│   ├── manifest.json                  # PWA manifest
│   └── sw.ts                          # Service Worker (offline cache)
│
└── vite.config.ts                     # Vite + vite-plugin-pwa
```

---

## 10. Flujo de Cache (3 capas)

```
Player pide chunk
    │
    ├─▶ L1: LRU memoria (hit?) → <1ms
    │
    ├─▶ L2: IndexedDB (hit?) → ~5ms
    │
    └─▶ L3: CF Worker /tts
           ├─▶ R2 cache (hit?) → ~50ms
           └─▶ Edge TTS generar → ~500ms
                   │
                   └─▶ guardar en R2 + devolver
```

- **L1 (memoria):** Map con LRU eviction, max 100 chunks
- **L2 (IndexedDB):** persistente, max 500MB con LRU eviction por tamaño
- **L3 (R2):** cache server-side, TTL 30 días
- **Key unificada:** `hash(text + voiceId + speed)`

---

## 11. Edge Cases y Manejo de Errores

### 11.1 Errores de Extracción

| Caso | Comportamiento |
|---|---|
| PDF escaneado (sin texto) | Mostrar mensaje: "Este PDF no contiene texto seleccionable. Se requiere OCR." |
| PDF corrupto | `AgentResult<ExtractedDoc>` con error recoverable=false, toast al usuario |
| ePub sin capítulos | Crear un capítulo único con todos los párrafos |
| Párrafo vacío | Skip (no enviar a TTS) |

### 11.2 Errores de TTS

| Caso | Comportamiento |
|---|---|
| Edge TTS 429 (rate limited) | Retry con backoff exponencial (1s, 2s, 4s), max 3 intentos |
| Edge TTS 500 | Retry 1 vez, si falla marcar chunk como error, skip al siguiente |
| Chunk con word boundaries malformados | Usar timing uniforme (dividir duración total / palabras) como fallback |
| Worker timeout (>30s) | Reducir maxChunkChars y reintentar |

### 11.3 Errores de Cache

| Caso | Comportamiento |
|---|---|
| IndexedDB quota excedida | Evict LRU entries hasta liberar espacio, luego reintentar |
| IndexedDB corrupta | Clear all, re-generar desde R2 |

### 11.4 Errores de Playback

| Caso | Comportamiento |
|---|---|
| Audio no puede decodificarse | Re-fetch sin cache |
| Seek a posición sin timings | Pausar hasta que los timings del párrafo estén ready |
| Cambio de voz/velocidad mid-reproducción | Bump generationId, cancelar prefetch, re-generar desde posición actual |

---

## 12. PWA Features

| Feature | Implementación |
|---|---|
| Instalable | `manifest.json` + `vite-plugin-pwa` |
| Offline | Service Worker cachea: shell de la app + chunks de audio ya generados (IndexedDB) |
| Background audio | Media Session API para controles desde lock screen |
| Dark mode | CSS `prefers-color-scheme` |

---

## 13. MVP Scope (Funciones 1-8)

| # | Función | Estado |
|---|---|---|
| 1 | Importar PDF | MVP |
| 2 | Importar ePub | MVP |
| 3 | TTS con Edge TTS | MVP |
| 4 | Karaoke highlight palabra-por-palabra | MVP |
| 5 | Player (play/pause/skip/velocidad/volumen) | MVP |
| 6 | Cola de chunks con prefetch | MVP |
| 7 | Control de velocidad (0.5x-2x) | MVP |
| 8 | Selector de voz (3 voces femeninas) | MVP |

### Post-MVP (futuro)

- Continuar donde dejaste (bookmark automático)
- Visualización de libro (render del documento con párrafos clickeables)
- PWA install + offline + background audio
- Gestión de biblioteca
- Múltiples motores TTS (ElevenLabs, OpenAI)
- Exportar audio como MP3
- Salto por capítulo
- Notas y marcadores

---

## 14. Resumen de Auditoría del Agente-Juez

**Veredicto:** APPROVE WITH CHANGES (7/10)

**7 issues corregidos en este spec:**

| # | Issue | Corrección |
|---|---|---|
| 1 | `WordToken` overloaded | Split en `TokenPosition` + `WordTiming`; `Paragraph` sin `words` |
| 2 | Chunker sin interfaces | Definidos `ChunkJob`, `ChunkPlan`; `TTSChunk` con `paragraphId` + `chunkIndex` |
| 3 | God-store pattern | Split en `DocumentStore`, `PlaybackStore`, `CacheStore` |
| 4 | Sin error model | `PipelineError` + `AgentResult<T>`; todos los agentes lo retornan |
| 5 | Prefetch sin invalidación | `generationId` bumped en voice/speed/seek |
| 6 | Player agent/component blur | `PlayerAgent` interface + tabla de responsibilities |
| 7 | Null state ambiguo | `TimingStatus` discriminated union |

**5 recomendaciones integradas:**

| # | Recomendación | Integrada en |
|---|---|---|
| R1 | `src/types/` centralizado | §9 estructura de archivos |
| R2 | `VoiceConfig` type | §4.3 tipos de TTS |
| R3 | `src/hooks/` capa intermedia | §3.4 + §9 |
| R4 | `CacheLayer` + `TieredCache` tipados | §4.5 tipos de cache |
| R5 | Metadata en `ExtractedDoc` + `Chapter` | §4.1 tipos de documento |
