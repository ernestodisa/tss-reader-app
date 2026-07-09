# Speechify Clone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a PWA that reads PDFs and ePubs as audiobooks with word-by-word karaoke highlight, using Edge TTS via a Cloudflare Worker backend.

**Architecture:** 4-agent pipeline (Extractor → Chunker → TTS Client → Player) running client-side in a React+Vite PWA, with a Cloudflare Worker proxying Edge TTS and caching in R2. State split across 3 Zustand stores. 3-layer cache (LRU memory → IndexedDB → R2).

**Tech Stack:** React 18, Vite 5, TypeScript, Zustand, pdf.js, epub.js, Web Audio API, Cloudflare Workers, R2, vite-plugin-pwa

## Global Constraints

- TypeScript strict mode enabled
- Target: iOS Safari 16+ and macOS Safari 16+ (PWA)
- Edge TTS max chunk size: 500 characters
- CF Worker execution limit: 30s per request
- All agents return `AgentResult<T>`, never raw throws
- Voces MVP: solo femeninas (Dalia es-MX, Elvira es-ES, Aria en-US)
- Spec location: `docs/specs/2026-07-09-speechify-clone-design.md`

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `.gitignore`
- Create: `src/vite-env.d.ts`

**Interfaces:**
- Produces: a running Vite dev server with React + TypeScript

- [ ] **Step 1: Create project directory and init**

```bash
cd ~/Claude\ Cowork/projects/speechify-clone
npm create vite@latest . -- --template react-ts
```

- [ ] **Step 2: Install dependencies**

```bash
npm install zustand pdfjs-dist epubjs-js idb-keyval
npm install -D vite-plugin-pwa @types/node wrangler
```

- [ ] **Step 3: Configure Vite with PWA**

`vite.config.ts`:
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Speechify Clone',
        short_name: 'Reader',
        display: 'standalone',
        background_color: '#1a1a1a',
        theme_color: '#1a1a1a',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  worker: {
    format: 'es',
  },
});
```

- [ ] **Step 4: Configure pdf.js worker**

`src/lib/pdf-utils.ts`:
```typescript
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjsLib };
```

- [ ] **Step 5: Verify dev server starts**

```bash
npm run dev
```

Expected: Vite dev server running on http://localhost:5173

- [ ] **Step 6: Git init and commit**

```bash
git init
git add -A
git commit -m "chore: scaffold React+Vite+TS PWA with dependencies"
```

---

### Task 2: Type Definitions

**Files:**
- Create: `src/types/document.ts`
- Create: `src/types/chunk.ts`
- Create: `src/types/tts.ts`
- Create: `src/types/player.ts`
- Create: `src/types/errors.ts`
- Create: `src/types/cache.ts`
- Create: `src/types/index.ts`

**Interfaces:**
- Produces: all domain types imported via `src/types/index.ts`
- Consumes: nothing (foundational)

- [ ] **Step 1: Create document types**

`src/types/document.ts`:
```typescript
export interface ExtractedDoc {
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

export interface Chapter {
  id: string;
  title: string;
  paragraphs: Paragraph[];
  index: number;
  totalCharacters: number;
  estimatedDurationMs?: number;
}

export interface Paragraph {
  id: string;
  text: string;
  chapterId: string;
  page?: number;
}

export interface TokenPosition {
  wordIndex: number;
  charStart: number;
  charEnd: number;
}
```

- [ ] **Step 2: Create chunk types**

`src/types/chunk.ts`:
```typescript
export interface TTSChunk {
  id: string;
  paragraphId: string;
  chunkIndex: number;
  text: string;
  voiceId: string;
  speed: number;
}

export interface ChunkJob {
  paragraphId: string;
  paragraphText: string;
  voiceId: string;
  speed: number;
  maxChunkChars: number;
  strategy: 'sentence' | 'fixed' | 'paragraph';
}

export interface ChunkPlan {
  paragraphId: string;
  chunks: TTSChunk[];
  estimatedDurationMs: number;
  wordOffsetMap: Map<number, number>;
}
```

- [ ] **Step 3: Create TTS types**

`src/types/tts.ts`:
```typescript
export interface WordTiming {
  wordIndex: number;
  text: string;
  offsetMs: number;
  durationMs: number;
}

export interface TTSResponse {
  chunkId: string;
  audio: ArrayBuffer;
  format: 'mp3' | 'ogg';
  words: WordTiming[];
  durationMs: number;
}

export interface VoiceConfig {
  id: string;
  name: string;
  language: string;
  gender?: string;
  engine: 'edge' | 'elevenlabs' | 'openai' | 'playht';
  sampleRate?: number;
}

export const AVAILABLE_VOICES: VoiceConfig[] = [
  { id: 'es-MX-DaliaNeural', name: 'Dalia', language: 'es-MX', gender: 'female', engine: 'edge' },
  { id: 'es-ES-ElviraNeural', name: 'Elvira', language: 'es-ES', gender: 'female', engine: 'edge' },
  { id: 'en-US-AriaNeural', name: 'Aria', language: 'en-US', gender: 'female', engine: 'edge' },
];
```

- [ ] **Step 4: Create error types**

`src/types/errors.ts`:
```typescript
export type PipelineStep = 'extract' | 'chunk' | 'tts' | 'play';

export interface PipelineError {
  step: PipelineStep;
  paragraphId?: string;
  chunkId?: string;
  code: string;
  message: string;
  recoverable: boolean;
  retryAfterMs?: number;
}

export type AgentResult<T> =
  | { success: true; data: T }
  | { success: false; error: PipelineError };
```

- [ ] **Step 5: Create cache types**

`src/types/cache.ts`:
```typescript
export type CacheKey = `${string}:${string}`;

export interface CacheEntry<T> {
  key: CacheKey;
  value: T;
  createdAt: number;
  lastAccessedAt: number;
  sizeBytes: number;
  ttlMs: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  sizeBytes: number;
  entries: number;
}

export interface CacheLayer {
  get<T>(key: CacheKey): Promise<CacheEntry<T> | null>;
  put<T>(key: CacheKey, value: T, ttlMs: number): Promise<void>;
  delete(key: CacheKey): Promise<void>;
  clear(): Promise<void>;
  stats(): CacheStats;
}
```

- [ ] **Step 6: Create player types**

`src/types/player.ts`:
```typescript
import { WordTiming } from './tts';

export type TimingStatus =
  | { status: 'idle' }
  | { status: 'fetching' }
  | { status: 'ready'; timings: WordTiming[] }
  | { status: 'error'; error: import('./errors').PipelineError };

export interface PlayerState {
  isPlaying: boolean;
  isBuffering: boolean;
  positionMs: number;
  wordIndex: number;
}
```

- [ ] **Step 7: Create barrel export**

`src/types/index.ts`:
```typescript
export * from './document';
export * from './chunk';
export * from './tts';
export * from './errors';
export * from './cache';
export * from './player';
```

- [ ] **Step 8: Verify type-checking passes**

```bash
npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 9: Commit**

```bash
git add src/types/
git commit -m "feat: add centralized type definitions for all domain contracts"
```

---

### Task 3: Hash and Tokenizer Utilities

**Files:**
- Create: `src/lib/hash.ts`
- Create: `src/lib/tokenizer.ts`

**Interfaces:**
- Produces: `hashString(s: string): string`, `tokenize(text: string): TokenPosition[]`
- Consumes: `TokenPosition` from `src/types/document.ts`

- [ ] **Step 1: Create hash utility**

`src/lib/hash.ts`:
```typescript
// Simple synchronous hash (djb2) — sufficient for cache keys
export function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash = hash & 0xffffffff; // Force 32-bit
  }
  return Math.abs(hash).toString(16);
}

export function chunkId(text: string, voiceId: string, speed: number): string {
  return hashString(`${text}::${voiceId}::${speed}`);
}
```

- [ ] **Step 2: Create tokenizer**

`src/lib/tokenizer.ts`:
```typescript
import { TokenPosition } from '../types';

export function tokenize(text: string): TokenPosition[] {
  const tokens: TokenPosition[] = [];
  const regex = /\S+/g;
  let match;
  let wordIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    tokens.push({
      wordIndex,
      charStart: match.index,
      charEnd: match.index + match[0].length,
    });
    wordIndex++;
  }
  return tokens;
}
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/hash.ts src/lib/tokenizer.ts
git commit -m "feat: add hash and tokenizer utilities"
```

---

### Task 4: Cloudflare Worker — TTS Endpoint

**Files:**
- Create: `worker/wrangler.toml`
- Create: `worker/src/index.ts`
- Create: `worker/src/edge-tts.ts`
- Create: `worker/src/ssml-builder.ts`
- Create: `worker/src/r2-cache.ts`
- Create: `worker/src/types.ts`
- Create: `worker/src/multi-engine.ts`
- Create: `worker/package.json`

**Interfaces:**
- Produces: `POST /tts` endpoint that returns audio + word timings
- Consumes: Edge TTS public API (WebSocket-based)

- [ ] **Step 1: Create worker package.json**

`worker/package.json`:
```json
{
  "name": "speechify-worker",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240620.0",
    "wrangler": "^3.60.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create wrangler.toml**

`worker/wrangler.toml`:
```toml
name = "speechify-tts"
main = "src/index.ts"
compatibility_date = "2024-06-01"

[[r2_buckets]]
binding = "TTS_CACHE"
bucket_name = "speechify-tts-cache"
```

- [ ] **Step 3: Create worker types**

`worker/src/types.ts`:
```typescript
export interface TTSRequest {
  text: string;
  voiceId: string;
  speed: number;
  format: 'mp3' | 'ogg';
}

export interface TTSEngine {
  synthesize(text: string, voiceId: string, speed: number): Promise<{
    audio: ArrayBuffer;
    words: { wordIndex: number; text: string; offsetMs: number; durationMs: number }[];
    durationMs: number;
  }>;
}

export interface Env {
  TTS_CACHE: R2Bucket;
}
```

- [ ] **Step 4: Create SSML builder**

`worker/src/ssml-builder.ts`:
```typescript
export function buildSSML(text: string, voiceId: string, speed: number): string {
  const speedPercent = Math.round(speed * 100);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
    <voice name="${voiceId}">
      <prosody rate="${speedPercent}%">
        ${escapeXml(text)}
      </prosody>
    </voice>
  </speak>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
```

- [ ] **Step 5: Create Edge TTS client**

`worker/src/edge-tts.ts`:
```typescript
import { buildSSML } from './ssml-builder';
import type { TTSEngine } from './types';

// Edge TTS uses a WebSocket API at speech.platform.bing.com
// We construct the WS URL with a token obtained from the token endpoint

const EDGE_TTS_WS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_TTS_TOKEN_URL = 'https://edge.microsoft.com/translate/auth';

interface EdgeWordBoundary {
  wordIndex: number;
  text: string;
  offsetMs: number;
  durationMs: number;
}

export const edgeTTS: TTSEngine = {
  async synthesize(text: string, voiceId: string, speed: number): Promise<{
    audio: ArrayBuffer;
    words: EdgeWordBoundary[];
    durationMs: number;
  }> {
    const ssml = buildSSML(text, voiceId, speed);

    // Get auth token
    const tokenResp = await fetch(EDGE_TTS_TOKEN_URL);
    const token = await tokenResp.text();

    // Connect WebSocket
    const wsUrl = `${EDGE_TTS_WS_URL}?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${crypto.randomUUID()}`;

    // Cloudflare Workers support WebSocket client via `fetch` upgrade
    const wsResp = await fetch(wsUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      // @ts-expect-error - CF Workers WebSocket upgrade
      method: 'GET',
    });

    const ws = wsResp.webSocket;
    if (!ws) {
      throw new Error('Failed to establish WebSocket connection to Edge TTS');
    }

    return new Promise((resolve, reject) => {
      const audioChunks: Uint8Array[] = [];
      const words: EdgeWordBoundary[] = [];
      let wordCounter = 0;

      ws.addEventListener('open', () => {
        // Send config
        ws.send(JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataOptions: {
                  sentenceBoundaryEnabled: 'false',
                  wordBoundaryEnabled: 'true',
                },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        }));
        // Send SSML
        ws.send(ssml);
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as string;
        if (data.startsWith('Path:audio')) {
          // Binary audio follows after the header line
          // In CF Workers, binary frames come as ArrayBuffer
          return;
        }
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'audio' && msg.data) {
            // Binary audio chunk (base64 in some implementations)
            const binary = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
            audioChunks.push(binary);
          } else if (msg.type === 'WordBoundary') {
            // Offset is in 100-nanosecond units, convert to ms
            const offsetMs = Math.round(msg.offset / 10000);
            const durationMs = Math.round(msg.duration / 10000);
            words.push({
              wordIndex: wordCounter++,
              text: msg.text,
              offsetMs,
              durationMs,
            });
          } else if (msg.type === 'turn.end') {
            // Synthesis complete
            const totalBytes = audioChunks.reduce((sum, c) => sum + c.length, 0);
            const audio = new Uint8Array(totalBytes);
            let offset = 0;
            for (const chunk of audioChunks) {
              audio.set(chunk, offset);
              offset += chunk.length;
            }
            const durationMs = words.length > 0
              ? words[words.length - 1].offsetMs + words[words.length - 1].durationMs
              : 0;
            ws.close();
            resolve({ audio: audio.buffer, words, durationMs });
          }
        } catch {
          // Binary data — could be raw audio bytes
          if (event.data instanceof ArrayBuffer) {
            audioChunks.push(new Uint8Array(event.data));
          }
        }
      });

      ws.addEventListener('error', () => {
        reject(new Error('Edge TTS WebSocket error'));
      });

      // Timeout after 25s (CF Worker limit is 30s)
      setTimeout(() => {
        ws.close();
        reject(new Error('Edge TTS timeout'));
      }, 25000);
    });
  },
};
```

> **Note:** Edge TTS WebSocket protocol is reverse-engineered. The exact message format may need adjustment during testing. Alternative: use the `edge-tts-universal` npm package which handles this protocol if available.

- [ ] **Step 6: Create R2 cache**

`worker/src/r2-cache.ts`:
```typescript
import type { Env } from './types';

export async function getCached(env: Env, key: string): Promise<{ audio: ArrayBuffer; words: string; durationMs: number } | null> {
  const obj = await env.TTS_CACHE.get(`tts:${key}`);
  if (!obj) return null;
  const words = obj.customMetadata?.words || '[]';
  const durationMs = parseInt(obj.customMetadata?.durationMs || '0', 10);
  const audio = await obj.arrayBuffer();
  return { audio, words, durationMs };
}

export async function putCache(
  env: Env,
  key: string,
  audio: ArrayBuffer,
  words: string,
  durationMs: number,
): Promise<void> {
  await env.TTS_CACHE.put(`tts:${key}`, audio, {
    customMetadata: { words, durationMs: durationMs.toString() },
    // R2 TTL not available on free plan; entries are evicted by LRU in client
  });
}
```

- [ ] **Step 7: Create multi-engine router**

`worker/src/multi-engine.ts`:
```typescript
import { edgeTTS } from './edge-tts';
import type { TTSEngine } from './types';

type EngineName = 'edge';

const engines: Record<EngineName, TTSEngine> = {
  edge: edgeTTS,
};

export function getEngine(name: EngineName = 'edge'): TTSEngine {
  return engines[name] ?? engines.edge;
}
```

- [ ] **Step 8: Create Worker entry point**

`worker/src/index.ts`:
```typescript
import { getEngine } from './multi-engine';
import { getCached, putCache } from './r2-cache';
import type { Env, TTSRequest } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/tts') {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    let body: TTSRequest;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
    }

    const { text, voiceId, speed, format } = body;
    if (!text || !voiceId) {
      return new Response(JSON.stringify({ error: 'missing_params' }), { status: 400 });
    }

    // Generate cache key
    const cacheKey = `${hashKey(text)}::${voiceId}::${speed}`;

    // Check R2 cache
    const cached = await getCached(env, cacheKey);
    if (cached) {
      return new Response(cached.audio, {
        status: 200,
        headers: {
          'Content-Type': `audio/${format || 'mp3'}`,
          'X-Chunk-Id': cacheKey,
          'X-Words': cached.words,
          'X-Duration': cached.durationMs.toString(),
          'X-Cache': 'HIT',
        },
      });
    }

    // Synthesize
    try {
      const engine = getEngine('edge');
      const result = await engine.synthesize(text, voiceId, speed || 1.0);

      // Cache in R2
      await putCache(env, cacheKey, result.audio, JSON.stringify(result.words), result.durationMs);

      return new Response(result.audio, {
        status: 200,
        headers: {
          'Content-Type': `audio/${format || 'mp3'}`,
          'X-Chunk-Id': cacheKey,
          'X-Words': JSON.stringify(result.words),
          'X-Duration': result.durationMs.toString(),
          'X-Cache': 'MISS',
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      const isRateLimit = message.includes('429') || message.includes('rate');
      return new Response(JSON.stringify({
        error: isRateLimit ? 'rate_limited' : 'tts_failed',
        message,
        retryAfterMs: isRateLimit ? 1000 : undefined,
      }), {
        status: isRateLimit ? 429 : 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

function hashKey(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash = hash & 0xffffffff;
  }
  return Math.abs(hash).toString(16);
}
```

- [ ] **Step 9: Install worker deps and type-check**

```bash
cd worker && npm install && npx tsc --noEmit
```

- [ ] **Step 10: Test worker locally**

```bash
cd worker && npx wrangler dev --local
```

Test with curl:
```bash
curl -X POST http://localhost:8787/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hola mundo","voiceId":"es-MX-DaliaNeural","speed":1.0,"format":"mp3"}' \
  -o test.mp3
```

Expected: MP3 audio file downloaded, `X-Words` header contains JSON array.

- [ ] **Step 11: Commit**

```bash
git add worker/
git commit -m "feat: add Cloudflare Worker with Edge TTS endpoint and R2 cache"
```

---

### Task 5: Cache Layer (Client-Side)

**Files:**
- Create: `src/lib/memory-cache.ts`
- Create: `src/lib/indexeddb-cache.ts`
- Create: `src/lib/tiered-cache.ts`
- Create: `src/store/cache-store.ts`

**Interfaces:**
- Consumes: `CacheLayer`, `CacheEntry`, `CacheKey` from `src/types/cache.ts`
- Produces: `TieredCache` class + `useCacheStore` Zustand hook

- [ ] **Step 1: Create LRU memory cache**

`src/lib/memory-cache.ts`:
```typescript
import type { CacheEntry, CacheKey, CacheLayer, CacheStats } from '../types';

const MAX_ENTRIES = 100;

export class MemoryCache implements CacheLayer {
  private map = new Map<CacheKey, CacheEntry<unknown>>();
  private _stats: CacheStats = { hits: 0, misses: 0, sizeBytes: 0, entries: 0 };

  async get<T>(key: CacheKey): Promise<CacheEntry<T> | null> {
    const entry = this.map.get(key) as CacheEntry<T> | undefined;
    if (!entry) {
      this._stats.misses++;
      return null;
    }
    // Move to end (most recently used)
    this.map.delete(key);
    entry.lastAccessedAt = Date.now();
    this.map.set(key, entry);
    this._stats.hits++;
    return entry;
  }

  async put<T>(key: CacheKey, value: T, ttlMs: number): Promise<void> {
    // Evict oldest if at capacity
    while (this.map.size >= MAX_ENTRIES) {
      const oldestKey = this.map.keys().next().value;
      const evicted = this.map.get(oldestKey);
      if (evicted) this._stats.sizeBytes -= evicted.sizeBytes;
      this.map.delete(oldestKey);
    }
    const sizeBytes = estimateSize(value);
    const entry: CacheEntry<T> = {
      key, value, sizeBytes,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      ttlMs,
    };
    this.map.set(key, entry);
    this._stats.sizeBytes += sizeBytes;
    this._stats.entries = this.map.size;
  }

  async delete(key: CacheKey): Promise<void> {
    const entry = this.map.get(key);
    if (entry) this._stats.sizeBytes -= entry.sizeBytes;
    this.map.delete(key);
    this._stats.entries = this.map.size;
  }

  async clear(): Promise<void> {
    this.map.clear();
    this._stats.sizeBytes = 0;
    this._stats.entries = 0;
  }

  stats(): CacheStats {
    return { ...this._stats };
  }
}

function estimateSize(value: unknown): number {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value === 'string') return value.length * 2;
  try { return JSON.stringify(value).length * 2; } catch { return 1024; }
}
```

- [ ] **Step 2: Create IndexedDB cache**

`src/lib/indexeddb-cache.ts`:
```typescript
import { get, set, del, clear, createStore } from 'idb-keyval';
import type { CacheEntry, CacheKey, CacheLayer, CacheStats } from '../types';

const MAX_BYTES = 500 * 1024 * 1024; // 500MB

export class IndexedDBCache implements CacheLayer {
  private store = createStore('speechify-cache', 'keyval');
  private _stats: CacheStats = { hits: 0, misses: 0, sizeBytes: 0, entries: 0 };

  async get<T>(key: CacheKey): Promise<CacheEntry<T> | null> {
    const entry = await get<CacheEntry<T>>(key, this.store);
    if (!entry) {
      this._stats.misses++;
      return null;
    }
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      await del(key, this.store);
      this._stats.misses++;
      return null;
    }
    entry.lastAccessedAt = Date.now();
    this._stats.hits++;
    return entry;
  }

  async put<T>(key: CacheKey, value: T, ttlMs: number): Promise<void> {
    const sizeBytes = value instanceof ArrayBuffer ? value.byteLength : JSON.stringify(value).length * 2;
    const entry: CacheEntry<T> = {
      key, value, sizeBytes,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      ttlMs,
    };
    try {
      await set(key, entry, this.store);
      this._stats.sizeBytes += sizeBytes;
      this._stats.entries++;
    } catch (e) {
      // Quota exceeded — evict and retry
      await this.evictOldest();
      await set(key, entry, this.store);
    }
  }

  async delete(key: CacheKey): Promise<void> {
    await del(key, this.store);
  }

  async clear(): Promise<void> {
    await clear(this.store);
    this._stats = { hits: 0, misses: 0, sizeBytes: 0, entries: 0 };
  }

  stats(): CacheStats {
    return { ...this._stats };
  }

  private async evictOldest(): Promise<void> {
    // Simplified: clear 25% of entries
    await clear(this.store);
    this._stats.sizeBytes = 0;
    this._stats.entries = 0;
  }
}
```

- [ ] **Step 3: Create tiered cache facade**

`src/lib/tiered-cache.ts`:
```typescript
import type { CacheEntry, CacheKey, CacheLayer, CacheStats } from '../types';
import { MemoryCache } from './memory-cache';
import { IndexedDBCache } from './indexeddb-cache';

export class TieredCache implements CacheLayer {
  private layers: CacheLayer[];

  constructor(layers?: CacheLayer[]) {
    this.layers = layers ?? [new MemoryCache(), new IndexedDBCache()];
  }

  async get<T>(key: CacheKey): Promise<CacheEntry<T> | null> {
    for (let i = 0; i < this.layers.length; i++) {
      const entry = await this.layers[i].get<T>(key);
      if (entry) {
        // Promote to higher layers
        for (let j = 0; j < i; j++) {
          await this.layers[j].put(key, entry.value, entry.ttlMs);
        }
        return entry;
      }
    }
    return null;
  }

  async put<T>(key: CacheKey, value: T, ttlMs: number): Promise<void> {
    // Write to all layers
    await Promise.all(this.layers.map(l => l.put(key, value, ttlMs)));
  }

  async delete(key: CacheKey): Promise<void> {
    await Promise.all(this.layers.map(l => l.delete(key)));
  }

  async clear(): Promise<void> {
    await Promise.all(this.layers.map(l => l.clear()));
  }

  stats(): CacheStats {
    // Return stats from first layer (most relevant)
    return this.layers[0].stats();
  }
}
```

- [ ] **Step 4: Create cache store**

`src/store/cache-store.ts`:
```typescript
import { create } from 'zustand';
import { TieredCache } from '../lib/tiered-cache';
import type { WordTiming } from '../types';

const cache = new TieredCache();
const TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

interface CacheStore {
  hits: number;
  misses: number;
  getAudio: (chunkId: string) => Promise<AudioBuffer | null>;
  putAudio: (chunkId: string, buffer: AudioBuffer) => Promise<void>;
  getTimings: (chunkId: string) => Promise<WordTiming[] | null>;
  putTimings: (chunkId: string, timings: WordTiming[]) => Promise<void>;
  clear: () => Promise<void>;
}

export const useCacheStore = create<CacheStore>((set) => ({
  hits: 0,
  misses: 0,
  getAudio: async (chunkId: string) => {
    const entry = await cache.get<ArrayBuffer>(`audio:${chunkId}`);
    if (entry) {
      set(s => ({ hits: s.hits + 1 }));
      return entry.value as unknown as AudioBuffer;
    }
    set(s => ({ misses: s.misses + 1 }));
    return null;
  },
  putAudio: async (chunkId: string, buffer: AudioBuffer) => {
    // Store as ArrayBuffer (portable across AudioContext instances)
    const arrayBuffer = bufferToArrayBuffer(buffer);
    await cache.put(`audio:${chunkId}`, arrayBuffer, TTL);
  },
  getTimings: async (chunkId: string) => {
    const entry = await cache.get<WordTiming[]>(`timings:${chunkId}`);
    if (entry) return entry.value;
    return null;
  },
  putTimings: async (chunkId: string, timings: WordTiming[]) => {
    await cache.put(`timings:${chunkId}`, timings, TTL);
  },
  clear: async () => {
    await cache.clear();
    set({ hits: 0, misses: 0 });
  },
}));

// Helper — copy AudioBuffer to a transferable ArrayBuffer
function bufferToArrayBuffer(buffer: AudioBuffer): ArrayBuffer {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  // Store as raw PCM float32 with header
  const headerSize = 12; // channels(4) + length(4) + sampleRate(4)
  const totalSize = headerSize + channels * length * 4;
  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);
  view.setUint32(0, channels, true);
  view.setUint32(4, length, true);
  view.setUint32(8, sampleRate, true);
  let offset = headerSize;
  for (let ch = 0; ch < channels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      view.setFloat32(offset, channelData[i], true);
      offset += 4;
    }
  }
  return arrayBuffer;
}
```

- [ ] **Step 5: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/memory-cache.ts src/lib/indexeddb-cache.ts src/lib/tiered-cache.ts src/store/cache-store.ts
git commit -m "feat: add 3-tier cache layer (LRU memory + IndexedDB + facade)"
```

---

### Task 6: Extractor Agent (PDF + ePub)

**Files:**
- Create: `src/lib/pdf-utils.ts` (modify existing stub)
- Create: `src/lib/epub-utils.ts`
- Create: `src/agents/extractor.ts`
- Create: `src/workers/extract-worker.ts`

**Interfaces:**
- Consumes: `File` (PDF or ePub)
- Produces: `AgentResult<ExtractedDoc>` via `extractDocument(file: File): Promise<AgentResult<ExtractedDoc>>`

- [ ] **Step 1: Create PDF utils**

`src/lib/pdf-utils.ts`:
```typescript
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Chapter, Paragraph } from '../types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export async function extractPDF(file: File): Promise<{ title: string; author?: string; chapters: Chapter[]; totalPages: number }> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const meta = await pdf.getMetadata().catch(() => null);
  const title = meta?.info?.Title || file.name.replace(/\.pdf$/i, '');
  const author = meta?.info?.Author;

  const chapters: Chapter[] = [];
  let globalParaCounter = 0;

  // Simple extraction: each page is a "chapter" for PDFs without TOC
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // Reconstruct paragraphs from text items
    const textItems = content.items
      .filter((item): item is { str: string; transform: number[]; width: number; height: number } => 'str' in item)
      .map(item => ({
        str: item.str,
        y: item.transform[5],
        x: item.transform[4],
      }));

    const paragraphs = groupIntoParagraphs(textItems, pageNum, globalParaCounter);
    globalParaCounter += paragraphs.length;

    if (paragraphs.length > 0) {
      chapters.push({
        id: `pdf-ch-${pageNum}`,
        title: `Página ${pageNum}`,
        paragraphs,
        index: pageNum,
        totalCharacters: paragraphs.reduce((sum, p) => sum + p.text.length, 0),
      });
    }
  }

  return { title, author, chapters, totalPages: pdf.numPages };
}

interface TextItem {
  str: string;
  y: number;
  x: number;
}

function groupIntoParagraphs(items: TextItem[], page: number, startCounter: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let currentText = '';
  let lastY: number | null = null;
  const LINE_HEIGHT_THRESHOLD = 5; // pixels

  for (const item of items) {
    if (lastY !== null && Math.abs(item.y - lastY) > LINE_HEIGHT_THRESHOLD) {
      // New line — check if paragraph break
      if (currentText.trim()) {
        // Heuristic: if line ended with sentence terminator, new paragraph
        if (/[.!?]\s*$/.test(currentText.trim())) {
          paragraphs.push({
            id: `pdf-p-${page}-${startCounter + paragraphs.length}`,
            text: currentText.trim(),
            chapterId: `pdf-ch-${page}`,
            page,
          });
          currentText = '';
        }
      }
    }
    currentText += item.str;
    lastY = item.y;
  }

  if (currentText.trim()) {
    paragraphs.push({
      id: `pdf-p-${page}-${startCounter + paragraphs.length}`,
      text: currentText.trim(),
      chapterId: `pdf-ch-${page}`,
      page,
    });
  }

  return paragraphs;
}
```

- [ ] **Step 2: Create ePub utils**

`src/lib/epub-utils.ts`:
```typescript
import ePub from 'epubjs';
import type { Chapter, Paragraph } from '../types';

export async function extractEPub(file: File): Promise<{ title: string; author?: string; chapters: Chapter[] }> {
  const arrayBuffer = await file.arrayBuffer();
  const book = ePub(arrayBuffer);

  const title = book.packaging?.metadata?.title || file.name.replace(/\.epub$/i, '');
  const author = book.packaging?.metadata?.creator;

  const chapters: Chapter[] = [];
  let globalParaCounter = 0;

  const spine = await book.loaded.spine;
  const items = spine.items;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.href) continue;

    const doc = await item.load(book.load.bind(book));
    const text = (doc as Document).body?.textContent || '';

    // Split into paragraphs
    const paraTexts = text.split(/\n\n+|\r\n\r\n+/).map(p => p.trim()).filter(p => p.length > 0);

    const paragraphs: Paragraph[] = paraTexts.map((text, j) => ({
      id: `epub-p-${i}-${j}`,
      text,
      chapterId: `epub-ch-${i}`,
    }));

    globalParaCounter += paragraphs.length;

    if (paragraphs.length > 0) {
      const chapterTitle = (doc as Document).querySelector('h1, h2, title')?.textContent || `Capítulo ${i + 1}`;
      chapters.push({
        id: `epub-ch-${i}`,
        title: chapterTitle,
        paragraphs,
        index: i + 1,
        totalCharacters: paragraphs.reduce((sum, p) => sum + p.text.length, 0),
      });
    }

    item.unload();
  }

  book.destroy();

  return { title, author, chapters };
}
```

- [ ] **Step 3: Create extractor agent**

`src/agents/extractor.ts`:
```typescript
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

    const doc: ExtractedDoc = {
      title: raw.title,
      author: raw.author,
      chapters: raw.chapters,
      sourceType: isPdf ? 'pdf' : 'epub',
      totalPages: 'totalPages' in raw ? raw.totalPages : undefined,
      totalCharacters,
      estimatedDurationMs: Math.round(totalCharacters / 15 * 1000 * 60), // ~15 chars/sec at 1x
    };

    return { success: true, data: doc };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error';
    const isCorrupt = message.includes('password') || message.includes('Invalid') || message.includes('corrupt');

    const error: PipelineError = {
      step: 'extract',
      code: isCorrupt ? 'corrupt_file' : 'extraction_failed',
      message: isCorrupt
        ? 'El archivo está corrupto o protegido con contraseña.'
        : `Error al extraer texto: ${message}`,
      recoverable: false,
    };

    return { success: false, error };
  }
}
```

- [ ] **Step 4: Create web worker for extraction**

`src/workers/extract-worker.ts`:
```typescript
/// <reference lib="webworker" />
import { extractDocument } from '../agents/extractor';
import type { AgentResult, ExtractedDoc } from '../types';

self.onmessage = async (e: MessageEvent<File>) => {
  const result = await extractDocument(e.data);
  const transfer = result.success
    ? { doc: result.data, transfer: [] as Transferable[] }
    : { doc: null, transfer: [] };
  self.postMessage(result, transfer.transfer);
};

export {};
```

- [ ] **Step 5: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/pdf-utils.ts src/lib/epub-utils.ts src/agents/extractor.ts src/workers/extract-worker.ts
git commit -m "feat: add extractor agent for PDF and ePub parsing"
```

---

### Task 7: Chunker Agent

**Files:**
- Create: `src/agents/chunker.ts`

**Interfaces:**
- Consumes: `ChunkJob` from `src/types/chunk.ts`
- Produces: `AgentResult<ChunkPlan>` via `chunkParagraph(job: ChunkJob): Promise<AgentResult<ChunkPlan>>`

- [ ] **Step 1: Create chunker agent**

`src/agents/chunker.ts`:
```typescript
import { chunkId } from '../lib/hash';
import type { AgentResult, ChunkJob, ChunkPlan, TTSChunk, PipelineError } from '../types';

const DEFAULT_MAX_CHARS = 500;

export function chunkParagraph(job: ChunkJob): AgentResult<ChunkPlan> {
  const maxChars = job.maxChunkChars || DEFAULT_MAX_CHARS;

  try {
    const chunks: TTSChunk[] = [];
    const wordOffsetMap = new Map<number, number>(); // global wordIndex → chunkIndex

    if (job.paragraphText.length <= maxChars) {
      // Single chunk — no splitting needed
      const chunk: TTSChunk = {
        id: chunkId(job.paragraphText, job.voiceId, job.speed),
        paragraphId: job.paragraphId,
        chunkIndex: 0,
        text: job.paragraphText,
        voiceId: job.voiceId,
        speed: job.speed,
      };
      chunks.push(chunk);

      // Map all words to chunk 0
      const wordCount = job.paragraphText.split(/\s+/).length;
      for (let i = 0; i < wordCount; i++) {
        wordOffsetMap.set(i, 0);
      }
    } else {
      // Split by sentence boundaries
      const sentences = splitBySentence(job.paragraphText);
      let currentChunkText = '';
      let currentChunkIndex = 0;
      let globalWordIndex = 0;

      for (const sentence of sentences) {
        if (currentChunkText.length + sentence.length + 1 > maxChars && currentChunkText.length > 0) {
          // Flush current chunk
          const chunk: TTSChunk = {
            id: chunkId(currentChunkText, job.voiceId, job.speed),
            paragraphId: job.paragraphId,
            chunkIndex: currentChunkIndex,
            text: currentChunkText.trim(),
            voiceId: job.voiceId,
            speed: job.speed,
          };
          chunks.push(chunk);
          currentChunkText = '';
          currentChunkIndex++;
        }

        // Map words in this sentence to current chunk index
        const wordCount = sentence.split(/\s+/).filter(Boolean).length;
        for (let i = 0; i < wordCount; i++) {
          wordOffsetMap.set(globalWordIndex, currentChunkIndex);
          globalWordIndex++;
        }

        currentChunkText += (currentChunkText ? ' ' : '') + sentence;
      }

      // Flush remaining
      if (currentChunkText.trim()) {
        const chunk: TTSChunk = {
          id: chunkId(currentChunkText, job.voiceId, job.speed),
          paragraphId: job.paragraphId,
          chunkIndex: currentChunkIndex,
          text: currentChunkText.trim(),
          voiceId: job.voiceId,
          speed: job.speed,
        };
        chunks.push(chunk);
      }
    }

    // Estimate duration: ~15 chars/sec at 1x speed
    const estimatedDurationMs = Math.round(
      (job.paragraphText.length / 15) * 1000 / job.speed
    );

    return {
      success: true,
      data: {
        paragraphId: job.paragraphId,
        chunks,
        estimatedDurationMs,
        wordOffsetMap,
      },
    };
  } catch (err) {
    const error: PipelineError = {
      step: 'chunk',
      paragraphId: job.paragraphId,
      code: 'chunk_failed',
      message: err instanceof Error ? err.message : 'unknown chunking error',
      recoverable: false,
    };
    return { success: false, error };
  }
}

function splitBySentence(text: string): string[] {
  // Split on sentence boundaries while preserving the delimiter
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g);
  return sentences || [text];
}
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/agents/chunker.ts
git commit -m "feat: add chunker agent with sentence-aware splitting"
```

---

### Task 8: TTS Client Agent

**Files:**
- Create: `src/agents/tts-client.ts`
- Create: `src/lib/audio-utils.ts`

**Interfaces:**
- Consumes: `TTSChunk` from `src/types/chunk.ts`, `useCacheStore` from `src/store/cache-store.ts`
- Produces: `AgentResult<TTSResponse>` via `fetchTTS(chunk: TTSChunk): Promise<AgentResult<TTSResponse>>`

- [ ] **Step 1: Create audio utils**

`src/lib/audio-utils.ts`:
```typescript
let audioContext: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
  return audioContext;
}

export async function decodeAudio(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  return await ctx.decodeAudioData(arrayBuffer);
}

export function arrayBufferToAudioBuffer(
  arrayBuffer: ArrayBuffer,
  audioContext: AudioContext,
): Promise<AudioBuffer> {
  // Try to decode as MP3 first
  return audioContext.decodeAudioData(arrayBuffer.slice(0));
}

export function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
```

- [ ] **Step 2: Create TTS client agent**

`src/agents/tts-client.ts`:
```typescript
import { chunkId } from '../lib/hash';
import { useCacheStore } from '../store/cache-store';
import type { AgentResult, PipelineError, TTSChunk, TTSResponse, WordTiming } from '../types';

// Worker URL — configurable for dev/prod
const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787';

export async function fetchTTS(chunk: TTSChunk): Promise<AgentResult<TTSResponse>> {
  // Check client-side cache first
  const cachedAudio = await useCacheStore.getState().getAudio(chunk.id);
  const cachedTimings = await useCacheStore.getState().getTimings(chunk.id);

  if (cachedAudio && cachedTimings) {
    return {
      success: true,
      data: {
        chunkId: chunk.id,
        audio: await audioBufferToArrayBuffer(cachedAudio),
        format: 'mp3',
        words: cachedTimings,
        durationMs: cachedAudio.duration * 1000,
      },
    };
  }

  // Fetch from Worker
  try {
    const resp = await fetch(`${WORKER_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: chunk.text,
        voiceId: chunk.voiceId,
        speed: chunk.speed,
        format: 'mp3',
      }),
    });

    if (resp.status === 429) {
      const body = await resp.json().catch(() => ({}));
      return {
        success: false,
        error: {
          step: 'tts',
          chunkId: chunk.id,
          code: 'rate_limited',
          message: 'Edge TTS rate limited. Reintentando...',
          recoverable: true,
          retryAfterMs: body.retryAfterMs || 1000,
        },
      };
    }

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return {
        success: false,
        error: {
          step: 'tts',
          chunkId: chunk.id,
          code: 'tts_failed',
          message: body.message || `HTTP ${resp.status}`,
          recoverable: false,
        },
      };
    }

    const audio = await resp.arrayBuffer();
    const wordsHeader = resp.headers.get('X-Words') || '[]';
    const durationMs = parseInt(resp.headers.get('X-Duration') || '0', 10);
    const words: WordTiming[] = JSON.parse(wordsHeader);

    // Cache the result
    // Note: we store the raw ArrayBuffer for portability
    await useCacheStore.getState().putAudio(chunk.id, audioBufferFromArrayBuffer(audio));
    await useCacheStore.getState().putTimings(chunk.id, words);

    return {
      success: true,
      data: {
        chunkId: chunk.id,
        audio,
        format: 'mp3',
        words,
        durationMs,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: {
        step: 'tts',
        chunkId: chunk.id,
        code: 'network_error',
        message: err instanceof Error ? err.message : 'network error',
        recoverable: true,
        retryAfterMs: 2000,
      },
    };
  }
}

// Helper: create a dummy AudioBuffer wrapper for cache storage
// The cache store expects AudioBuffer but stores as ArrayBuffer internally
function audioBufferFromArrayBuffer(ab: ArrayBuffer): AudioBuffer {
  // Return as unknown — the cache store handles the conversion
  return ab as unknown as AudioBuffer;
}

async function audioBufferToArrayBuffer(ab: AudioBuffer): Promise<ArrayBuffer> {
  // If it's actually an ArrayBuffer (from cache), return directly
  if (ab instanceof ArrayBuffer) return ab;
  // Otherwise convert
  return ab.buffer?.slice(0) || new ArrayBuffer(0);
}
```

> **Note:** The cache store stores AudioBuffers as ArrayBuffers internally (see `bufferToArrayBuffer` in Task 5). The TTS client handles the conversion. During implementation you may need to adjust the exact types — the key invariant is that the raw bytes are preserved.

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/agents/tts-client.ts src/lib/audio-utils.ts
git commit -m "feat: add TTS client agent with cache integration"
```

---

### Task 9: Zustand Stores

**Files:**
- Create: `src/store/document-store.ts`
- Create: `src/store/playback-store.ts`
- Create: `src/store/library-store.ts`

**Interfaces:**
- Consumes: types from `src/types/`, `extractDocument` from `src/agents/extractor`
- Produces: `useDocumentStore`, `usePlaybackStore`, `useLibraryStore`

- [ ] **Step 1: Create document store**

`src/store/document-store.ts`:
```typescript
import { create } from 'zustand';
import { extractDocument } from '../agents/extractor';
import type { ExtractedDoc } from '../types';

interface DocumentStore {
  doc: ExtractedDoc | null;
  isLoading: boolean;
  error: string | null;
  loadDocument: (file: File) => Promise<boolean>;
  unloadDocument: () => void;
}

export const useDocumentStore = create<DocumentStore>((set) => ({
  doc: null,
  isLoading: false,
  error: null,

  loadDocument: async (file: File) => {
    set({ isLoading: true, error: null });
    const result = await extractDocument(file);
    if (result.success) {
      set({ doc: result.data, isLoading: false });
      return true;
    } else {
      set({ isLoading: false, error: result.error.message });
      return false;
    }
  },

  unloadDocument: () => {
    set({ doc: null, error: null, isLoading: false });
  },
}));
```

- [ ] **Step 2: Create playback store**

`src/store/playback-store.ts`:
```typescript
import { create } from 'zustand';
import type { ExtractedDoc, TimingStatus, WordTiming } from '../types';

interface PlaybackStore {
  // Position
  chapterIndex: number;
  paragraphIndex: number;
  wordIndex: number;
  positionMs: number;

  // State
  isPlaying: boolean;
  isBuffering: boolean;

  // Config
  voiceId: string;
  speed: number;
  generationId: number;

  // Timings
  timingsByParagraph: Map<string, TimingStatus>;

  // Actions
  play: () => void;
  pause: () => void;
  stop: () => void;
  setVoice: (id: string) => void;
  setSpeed: (speed: number) => void;
  setParagraphTiming: (paragraphId: string, status: TimingStatus) => void;
  setWordIndex: (index: number) => void;
  setPositionMs: (ms: number) => void;
  setBuffering: (buffering: boolean) => void;
  seekToParagraph: (chapterIndex: number, paragraphIndex: number) => void;
  nextParagraph: (doc: ExtractedDoc) => void;
  prevParagraph: (doc: ExtractedDoc) => void;
  bumpGeneration: () => void;
}

export const usePlaybackStore = create<PlaybackStore>((set) => ({
  chapterIndex: 0,
  paragraphIndex: 0,
  wordIndex: 0,
  positionMs: 0,
  isPlaying: false,
  isBuffering: false,
  voiceId: 'es-MX-DaliaNeural',
  speed: 1.0,
  generationId: 0,
  timingsByParagraph: new Map(),

  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  stop: () => set({ isPlaying: false, positionMs: 0, wordIndex: 0 }),

  setVoice: (id: string) => set((s) => ({
    voiceId: id,
    generationId: s.generationId + 1,
  })),

  setSpeed: (speed: number) => set((s) => ({
    speed,
    generationId: s.generationId + 1,
  })),

  setParagraphTiming: (paragraphId, status) => set((s) => {
    const newMap = new Map(s.timingsByParagraph);
    newMap.set(paragraphId, status);
    return { timingsByParagraph: newMap };
  }),

  setWordIndex: (index: number) => set({ wordIndex: index }),
  setPositionMs: (ms: number) => set({ positionMs: ms }),
  setBuffering: (buffering: boolean) => set({ isBuffering: buffering }),

  seekToParagraph: (chapterIndex: number, paragraphIndex: number) => set((s) => ({
    chapterIndex,
    paragraphIndex,
    wordIndex: 0,
    positionMs: 0,
    generationId: s.generationId + 1,
  })),

  nextParagraph: (doc: ExtractedDoc) => set((s) => {
    const chapter = doc.chapters[s.chapterIndex];
    if (s.paragraphIndex < chapter.paragraphs.length - 1) {
      return { paragraphIndex: s.paragraphIndex + 1, wordIndex: 0, positionMs: 0 };
    }
    // Move to next chapter
    if (s.chapterIndex < doc.chapters.length - 1) {
      return {
        chapterIndex: s.chapterIndex + 1,
        paragraphIndex: 0,
        wordIndex: 0,
        positionMs: 0,
      };
    }
    return {}; // End of document
  }),

  prevParagraph: (doc: ExtractedDoc) => set((s) => {
    if (s.paragraphIndex > 0) {
      return { paragraphIndex: s.paragraphIndex - 1, wordIndex: 0, positionMs: 0 };
    }
    if (s.chapterIndex > 0) {
      const prevChapter = doc.chapters[s.chapterIndex - 1];
      return {
        chapterIndex: s.chapterIndex - 1,
        paragraphIndex: prevChapter.paragraphs.length - 1,
        wordIndex: 0,
        positionMs: 0,
      };
    }
    return {};
  }),

  bumpGeneration: () => set((s) => ({ generationId: s.generationId + 1 })),
}));
```

- [ ] **Step 3: Create library store**

`src/store/library-store.ts`:
```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ExtractedDoc } from '../types';

interface LibraryEntry {
  id: string;
  title: string;
  author?: string;
  sourceType: 'pdf' | 'epub';
  totalPages?: number;
  totalCharacters: number;
  addedAt: number;
  lastReadChapter?: number;
  lastReadParagraph?: number;
}

interface LibraryStore {
  books: LibraryEntry[];
  addBook: (doc: ExtractedDoc) => void;
  removeBook: (id: string) => void;
  updateProgress: (id: string, chapter: number, paragraph: number) => void;
}

export const useLibraryStore = create<LibraryStore>()(
  persist(
    (set) => ({
      books: [],
      addBook: (doc: ExtractedDoc) => set((s) => ({
        books: [
          ...s.books,
          {
            id: `${doc.sourceType}-${doc.title}-${Date.now()}`,
            title: doc.title,
            author: doc.author,
            sourceType: doc.sourceType,
            totalPages: doc.totalPages,
            totalCharacters: doc.totalCharacters,
            addedAt: Date.now(),
          },
        ],
      })),
      removeBook: (id: string) => set((s) => ({
        books: s.books.filter(b => b.id !== id),
      })),
      updateProgress: (id, chapter, paragraph) => set((s) => ({
        books: s.books.map(b =>
          b.id === id
            ? { ...b, lastReadChapter: chapter, lastReadParagraph: paragraph }
            : b
        ),
      })),
    }),
    { name: 'speechify-library' },
  ),
);
```

- [ ] **Step 4: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/store/document-store.ts src/store/playback-store.ts src/store/library-store.ts
git commit -m "feat: add 3 Zustand stores (document, playback, library) with generationId"
```

---

### Task 10: React Hooks

**Files:**
- Create: `src/hooks/useDocument.ts`
- Create: `src/hooks/usePlayback.ts`
- Create: `src/hooks/useLibrary.ts`
- Create: `src/hooks/useKaraoke.ts`

**Interfaces:**
- Consumes: Zustand stores from Task 9
- Produces: React hooks for components to consume

- [ ] **Step 1: Create useDocument hook**

`src/hooks/useDocument.ts`:
```typescript
import { useDocumentStore } from '../store/document-store';

export function useDocument() {
  const { doc, isLoading, error, loadDocument, unloadDocument } = useDocumentStore();
  return { doc, isLoading, error, loadDocument, unloadDocument };
}
```

- [ ] **Step 2: Create usePlayback hook**

`src/hooks/usePlayback.ts`:
```typescript
import { usePlaybackStore } from '../store/playback-store';

export function usePlayback() {
  const store = usePlaybackStore();
  return {
    isPlaying: store.isPlaying,
    isBuffering: store.isBuffering,
    chapterIndex: store.chapterIndex,
    paragraphIndex: store.paragraphIndex,
    wordIndex: store.wordIndex,
    positionMs: store.positionMs,
    voiceId: store.voiceId,
    speed: store.speed,
    generationId: store.generationId,
    play: store.play,
    pause: store.pause,
    stop: store.stop,
    setVoice: store.setVoice,
    setSpeed: store.setSpeed,
    seekToParagraph: store.seekToParagraph,
    nextParagraph: store.nextParagraph,
    prevParagraph: store.prevParagraph,
    setParagraphTiming: store.setParagraphTiming,
    setWordIndex: store.setWordIndex,
    setPositionMs: store.setPositionMs,
    setBuffering: store.setBuffering,
    bumpGeneration: store.bumpGeneration,
  };
}
```

- [ ] **Step 3: Create useLibrary hook**

`src/hooks/useLibrary.ts`:
```typescript
import { useLibraryStore } from '../store/library-store';

export function useLibrary() {
  const { books, addBook, removeBook, updateProgress } = useLibraryStore();
  return { books, addBook, removeBook, updateProgress };
}
```

- [ ] **Step 4: Create useKaraoke hook**

`src/hooks/useKaraoke.ts`:
```typescript
import { useMemo } from 'react';
import { usePlaybackStore } from '../store/playback-store';
import type { WordTiming } from '../types';

export function useKaraoke(paragraphId: string) {
  const wordIndex = usePlaybackStore((s) => s.wordIndex);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const chapterIndex = usePlaybackStore((s) => s.chapterIndex);
  const paragraphIndex = usePlaybackStore((s) => s.paragraphIndex);
  const timingsStatus = usePlaybackStore((s) => s.timingsByParagraph.get(paragraphId));

  const timings: WordTiming[] | null = useMemo(() => {
    if (timingsStatus?.status === 'ready') return timingsStatus.timings;
    return null;
  }, [timingsStatus]);

  const isActive = useMemo(() => {
    // This paragraph is active if it's the current paragraph being played
    return isPlaying && timings !== null;
  }, [isPlaying, timings]);

  return {
    wordIndex,
    isActive,
    timings,
    isReady: timingsStatus?.status === 'ready',
    isFetching: timingsStatus?.status === 'fetching',
  };
}
```

- [ ] **Step 5: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/hooks/
git commit -m "feat: add React hooks layer (useDocument, usePlayback, useLibrary, useKaraoke)"
```

---

### Task 11: Player Agent (Audio Engine + rAF Karaoke)

**Files:**
- Create: `src/agents/player.ts`

**Interfaces:**
- Consumes: `AudioBuffer`, `WordTiming[]` from `src/types/`, `usePlaybackStore`
- Produces: `PlayerAgent` with `load()`, `play()`, `pause()`, `stop()`, `seek()`, `destroy()`, `onWordChange` callback

- [ ] **Step 1: Create player agent**

`src/agents/player.ts`:
```typescript
import { getAudioContext } from '../lib/audio-utils';
import { usePlaybackStore } from '../store/playback-store';
import type { WordTiming } from '../types';

type WordChangeCallback = (wordIndex: number, positionMs: number) => void;

class PlayerAgent {
  private audioContext: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private audioBuffer: AudioBuffer | null = null;
  private timings: WordTiming[] = [];
  private rafId: number | null = null;
  private startTime: number = 0;       // AudioContext.currentTime when playback started
  private startOffset: number = 0;     // offsetMs within the buffer where we started
  private onWordChange: WordChangeCallback | null = null;
  private isPlaying: boolean = false;
  private currentWordIndex: number = -1;

  setWordChangeCallback(cb: WordChangeCallback) {
    this.onWordChange = cb;
  }

  load(paragraphId: string, audio: AudioBuffer, timings: WordTiming[]) {
    this.stop();
    this.audioBuffer = audio;
    this.timings = timings;
    this.currentWordIndex = -1;
    this.startOffset = 0;
  }

  play() {
    if (!this.audioBuffer || this.isPlaying) return;

    this.audioContext = getAudioContext();
    this.source = this.audioContext.createBufferSource();
    this.source.buffer = this.audioBuffer;
    this.source.connect(this.audioContext.destination);

    this.startTime = this.audioContext.currentTime;
    this.isPlaying = true;

    // Update store
    usePlaybackStore.getState().play();

    this.source.onended = () => {
      this.isPlaying = false;
      this.stopRaf();
      // Auto-advance handled by component layer
    };

    this.source.start(0, this.startOffset / 1000);
    this.startRaf();
  }

  pause() {
    if (!this.isPlaying || !this.audioContext) return;

    // Calculate current position before stopping
    const elapsedMs = (this.audioContext.currentTime - this.startTime) * 1000;
    this.startOffset = this.startOffset + elapsedMs;

    this.stop();
    usePlaybackStore.getState().pause();

    // Keep buffer and timings for resume
    this.startOffset = Math.min(this.startOffset, (this.audioBuffer?.duration || 0) * 1000);
  }

  stop() {
    this.stopRaf();
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
    this.isPlaying = false;
  }

  fullStop() {
    this.stop();
    this.startOffset = 0;
    this.currentWordIndex = -1;
    usePlaybackStore.getState().stop();
  }

  seek(wordIndex: number) {
    if (!this.timings[wordIndex]) return;
    const targetMs = this.timings[wordIndex].offsetMs;

    const wasPlaying = this.isPlaying;
    this.stop();
    this.startOffset = targetMs;
    this.currentWordIndex = wordIndex - 1;

    if (wasPlaying) {
      this.play();
    }
  }

  destroy() {
    this.stop();
    this.audioBuffer = null;
    this.timings = [];
    this.onWordChange = null;
  }

  getCurrentPositionMs(): number {
    if (!this.audioContext || !this.isPlaying) return this.startOffset;
    const elapsedMs = (this.audioContext.currentTime - this.startTime) * 1000;
    return this.startOffset + elapsedMs;
  }

  private startRaf() {
    const tick = () => {
      if (!this.isPlaying) return;

      const positionMs = this.getCurrentPositionMs();

      // Find current word
      let newWordIndex = this.currentWordIndex;
      for (let i = this.currentWordIndex + 1; i < this.timings.length; i++) {
        if (this.timings[i].offsetMs <= positionMs) {
          newWordIndex = i;
        } else {
          break;
        }
      }

      if (newWordIndex !== this.currentWordIndex) {
        this.currentWordIndex = newWordIndex;
        usePlaybackStore.getState().setWordIndex(newWordIndex);
        usePlaybackStore.getState().setPositionMs(positionMs);
        if (this.onWordChange) {
          this.onWordChange(newWordIndex, positionMs);
        }
      }

      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopRaf() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}

// Singleton instance
export const playerAgent = new PlayerAgent();
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/agents/player.ts
git commit -m "feat: add player agent with AudioContext, rAF word tracking, and seek"
```

---

### Task 12: UI Components

**Files:**
- Create: `src/components/ImportDropzone.tsx`
- Create: `src/components/Library.tsx`
- Create: `src/components/ReaderView.tsx`
- Create: `src/components/KaraokeText.tsx`
- Create: `src/components/PlayerBar.tsx`
- Create: `src/components/VoiceSelector.tsx`
- Create: `src/components/SpeedControl.tsx`
- Modify: `src/App.tsx`
- Create: `src/styles/global.css`

**Interfaces:**
- Consumes: hooks from Task 10, `playerAgent` from Task 11, `AVAILABLE_VOICES` from `src/types/tts.ts`
- Produces: full PWA UI

- [ ] **Step 1: Create ImportDropzone**

`src/components/ImportDropzone.tsx`:
```tsx
import { useState, useCallback } from 'react';
import { useDocument } from '../hooks/useDocument';
import { useLibrary } from '../hooks/useLibrary';

export function ImportDropzone() {
  const { loadDocument, isLoading, error } = useDocument();
  const { addBook } = useLibrary();
  const [dragActive, setDragActive] = useState(false);

  const handleFile = useCallback(async (file: File) => {
    const success = await loadDocument(file);
    if (success) {
      // The doc is now in the store — we can add to library
      // (accessed via the store directly for the metadata)
    }
  }, [loadDocument, addBook]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div
      className={`dropzone ${dragActive ? 'active' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragLeave={() => setDragActive(false)}
      onDrop={onDrop}
    >
      <input
        type="file"
        accept=".pdf,.epub,application/pdf,application/epub+zip"
        onChange={onChange}
        style={{ display: 'none' }}
        id="file-input"
      />
      <label htmlFor="file-input" className="dropzone-label">
        {isLoading ? 'Procesando...' : 'Arrastra un PDF o ePub aquí'}
      </label>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Create Library**

`src/components/Library.tsx`:
```tsx
import { useLibrary } from '../hooks/useLibrary';

export function Library() {
  const { books, removeBook } = useLibrary();

  if (books.length === 0) {
    return <p className="library-empty">Sin libros en la biblioteca</p>;
  }

  return (
    <div className="library">
      {books.map((book) => (
        <div key={book.id} className="book-card">
          <div className="book-info">
            <h3>{book.title}</h3>
            {book.author && <p>{book.author}</p>}
            <span className="badge">{book.sourceType.toUpperCase()}</span>
            <span className="badge">{book.totalPages || '?'} págs</span>
          </div>
          <button onClick={() => removeBook(book.id)} className="btn-remove">✕</button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create KaraokeText**

`src/components/KaraokeText.tsx`:
```tsx
import { useRef, useEffect } from 'react';
import { useKaraoke } from '../hooks/useKaraoke';
import { tokenize } from '../lib/tokenizer';
import type { Paragraph } from '../types';

interface KaraokeTextProps {
  paragraph: Paragraph;
}

export function KaraokeText({ paragraph }: KaraokeTextProps) {
  const { wordIndex, isActive } = useKaraoke(paragraph.id);
  const containerRef = useRef<HTMLDivElement>(null);
  const tokens = tokenize(paragraph.text);

  // Auto-scroll to keep active word visible
  useEffect(() => {
    if (!isActive || wordIndex < 0) return;
    const activeSpan = containerRef.current?.querySelector(`[data-word="${wordIndex}"]`);
    activeSpan?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [wordIndex, isActive]);

  // Render text with word spans
  let charCursor = 0;
  return (
    <div ref={containerRef} className="karaoke-text">
      {tokens.map((token) => {
        // Render text between tokens (whitespace)
        const gap = paragraph.text.slice(charCursor, token.charStart);
        charCursor = token.charEnd;
        const isHighlighted = isActive && token.wordIndex === wordIndex;
        return (
          <span key={token.wordIndex}>
            {gap}
            <span
              data-word={token.wordIndex}
              className={isHighlighted ? 'word-highlight' : 'word'}
            >
              {paragraph.text.slice(token.charStart, token.charEnd)}
            </span>
          </span>
        );
      })}
      {paragraph.text.slice(charCursor)}
    </div>
  );
}
```

- [ ] **Step 4: Create ReaderView**

`src/components/ReaderView.tsx`:
```tsx
import { useDocument } from '../hooks/useDocument';
import { usePlayback } from '../hooks/usePlayback';
import { KaraokeText } from './KaraokeText';
import { PlayerBar } from './PlayerBar';

export function ReaderView() {
  const { doc } = useDocument();
  const { chapterIndex, paragraphIndex } = usePlayback();

  if (!doc) return null;

  const chapter = doc.chapters[chapterIndex];
  if (!chapter) return <p>Capítulo no encontrado</p>;

  // Render current paragraph + surrounding context
  const currentParagraph = chapter.paragraphs[paragraphIndex];

  return (
    <div className="reader-view">
      <div className="reader-header">
        <h2>{chapter.title}</h2>
        <span className="progress">
          {chapterIndex + 1}/{doc.chapters.length} · {paragraphIndex + 1}/{chapter.paragraphs.length}
        </span>
      </div>

      <div className="reader-content">
        {currentParagraph && <KaraokeText paragraph={currentParagraph} />}
      </div>

      <PlayerBar doc={doc} />
    </div>
  );
}
```

- [ ] **Step 5: Create VoiceSelector**

`src/components/VoiceSelector.tsx`:
```tsx
import { usePlayback } from '../hooks/usePlayback';
import { AVAILABLE_VOICES } from '../types/tts';

export function VoiceSelector() {
  const { voiceId, setVoice } = usePlayback();

  return (
    <select
      value={voiceId}
      onChange={(e) => setVoice(e.target.value)}
      className="voice-selector"
    >
      {AVAILABLE_VOICES.map((voice) => (
        <option key={voice.id} value={voice.id}>
          {voice.name} ({voice.language})
        </option>
      ))}
    </select>
  );
}
```

- [ ] **Step 6: Create SpeedControl**

`src/components/SpeedControl.tsx`:
```tsx
import { usePlayback } from '../hooks/usePlayback';

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

export function SpeedControl() {
  const { speed, setSpeed } = usePlayback();

  return (
    <div className="speed-control">
      {SPEEDS.map((s) => (
        <button
          key={s}
          className={speed === s ? 'active' : ''}
          onClick={() => setSpeed(s)}
        >
          {s}x
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Create PlayerBar**

`src/components/PlayerBar.tsx`:
```tsx
import { useEffect } from 'react';
import { usePlayback } from '../hooks/usePlayback';
import { useDocument } from '../hooks/useDocument';
import { playerAgent } from '../agents/player';
import { fetchTTS } from '../agents/tts-client';
import { chunkParagraph } from '../agents/chunker';
import { decodeAudio } from '../lib/audio-utils';
import type { ExtractedDoc, Paragraph } from '../types';

interface PlayerBarProps {
  doc: ExtractedDoc;
}

export function PlayerBar({ doc }: PlayerBarProps) {
  const {
    isPlaying, isBuffering, voiceId, speed,
    chapterIndex, paragraphIndex, generationId,
    play, pause, nextParagraph, prevParagraph,
    setBuffering, setParagraphTiming,
  } = usePlayback();

  // Load and play current paragraph
  const loadAndPlayParagraph = async (paragraph: Paragraph, voiceId: string, speed: number, gen: number) => {
    setBuffering(true);
    setParagraphTiming(paragraph.id, { status: 'fetching' });

    // Chunk
    const chunkResult = chunkParagraph({
      paragraphId: paragraph.id,
      paragraphText: paragraph.text,
      voiceId,
      speed,
      maxChunkChars: 500,
      strategy: 'sentence',
    });

    if (!chunkResult.success) {
      setParagraphTiming(paragraph.id, { status: 'error', error: chunkResult.error });
      setBuffering(false);
      return;
    }

    // Fetch TTS for all chunks in the plan
    const plan = chunkResult.data;
    const allTimings = [];
    const allAudioBuffers: AudioBuffer[] = [];

    for (const chunk of plan.chunks) {
      // Check generation — discard if stale
      if (usePlaybackStore.getState().generationId !== gen) return;

      const ttsResult = await fetchTTS(chunk);
      if (!ttsResult.success) {
        setParagraphTiming(paragraph.id, { status: 'error', error: ttsResult.error });
        setBuffering(false);
        return;
      }

      const audioBuffer = await decodeAudio(ttsResult.data.audio);
      allAudioBuffers.push(audioBuffer);
      allTimings.push(...ttsResult.data.words);
    }

    // For MVP: use the first chunk's audio (simplification — multi-chunk concatenation is post-MVP)
    // In practice, most paragraphs fit in one chunk
    const audio = allAudioBuffers[0];
    if (audio) {
      playerAgent.load(paragraph.id, audio, allTimings);
      setParagraphTiming(paragraph.id, { status: 'ready', timings: allTimings });
      playerAgent.play();
    }

    setBuffering(false);
  };

  // Handle play/pause toggle
  const handlePlayPause = async () => {
    if (isPlaying) {
      playerAgent.pause();
      return;
    }

    // If player already has audio loaded, just resume
    if (playerAgent.getCurrentPositionMs() > 0) {
      playerAgent.play();
      return;
    }

    // Otherwise, load current paragraph
    const chapter = doc.chapters[chapterIndex];
    const paragraph = chapter?.paragraphs[paragraphIndex];
    if (paragraph) {
      await loadAndPlayParagraph(paragraph, voiceId, speed, generationId);
    }
  };

  const handleNext = () => {
    playerAgent.fullStop();
    nextParagraph(doc);
    // Auto-play next paragraph
    const chapter = doc.chapters[usePlaybackStore.getState().chapterIndex];
    const paragraph = chapter?.paragraphs[usePlaybackStore.getState().paragraphIndex];
    if (paragraph) {
      loadAndPlayParagraph(paragraph, voiceId, speed, usePlaybackStore.getState().generationId);
    }
  };

  const handlePrev = () => {
    playerAgent.fullStop();
    prevParagraph(doc);
    const chapter = doc.chapters[usePlaybackStore.getState().chapterIndex];
    const paragraph = chapter?.paragraphs[usePlaybackStore.getState().paragraphIndex];
    if (paragraph) {
      loadAndPlayParagraph(paragraph, voiceId, speed, usePlaybackStore.getState().generationId);
    }
  };

  // Auto-advance when audio ends
  useEffect(() => {
    playerAgent.setWordChangeCallback(() => {
      // Word change tracking handled by rAF in playerAgent
    });

    return () => {
      playerAgent.destroy();
    };
  }, []);

  return (
    <div className="player-bar">
      <div className="player-controls">
        <button onClick={handlePrev} disabled={isBuffering}>⏮</button>
        <button onClick={handlePlayPause} disabled={isBuffering}>
          {isBuffering ? '⏳' : isPlaying ? '⏸' : '▶'}
        </button>
        <button onClick={handleNext} disabled={isBuffering}>⏭</button>
      </div>
      <div className="player-options">
        <VoiceSelector />
        <SpeedControl />
      </div>
    </div>
  );
}

// Need to import the store directly for reading current state in callbacks
import { usePlaybackStore } from '../store/playback-store';
import { VoiceSelector } from './VoiceSelector';
import { SpeedControl } from './SpeedControl';
```

> **Note:** The imports at the bottom of the file are shown there for clarity but should be moved to the top in the actual file. This is a known pattern issue — the implementation should consolidate all imports at the top.

- [ ] **Step 8: Create App.tsx**

`src/App.tsx`:
```tsx
import { ImportDropzone } from './components/ImportDropzone';
import { Library } from './components/Library';
import { ReaderView } from './components/ReaderView';
import { useDocument } from './hooks/useDocument';

export default function App() {
  const { doc } = useDocument();

  return (
    <div className="app">
      <header className="app-header">
        <h1>📖 Reader</h1>
      </header>
      <main className="app-main">
        {doc ? (
          <ReaderView />
        ) : (
          <>
            <ImportDropzone />
            <Library />
          </>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 9: Create global styles**

`src/styles/global.css`:
```css
:root {
  --bg: #1a1a1a;
  --bg-surface: #2a2a2a;
  --bg-elevated: #333;
  --text: #e0e0e0;
  --text-muted: #888;
  --accent: #6a8caf;
  --accent-bright: #8ab4cf;
  --error: #e57373;
  --radius: 8px;
  --shadow: 0 2px 8px rgba(0,0,0,0.3);
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #f5f5f5;
    --bg-surface: #fff;
    --bg-elevated: #eee;
    --text: #222;
    --text-muted: #666;
    --accent: #4a6a8f;
    --accent-bright: #6a8ab0;
    --shadow: 0 2px 8px rgba(0,0,0,0.1);
  }
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}

.app {
  max-width: 800px;
  margin: 0 auto;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-header {
  padding: 1rem;
  text-align: center;
  border-bottom: 1px solid var(--bg-elevated);
}

.app-header h1 {
  font-size: 1.5rem;
  font-weight: 500;
}

.app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 1rem;
  gap: 1rem;
}

/* Dropzone */
.dropzone {
  border: 2px dashed var(--bg-elevated);
  border-radius: var(--radius);
  padding: 3rem 2rem;
  text-align: center;
  transition: border-color 0.2s;
}

.dropzone.active {
  border-color: var(--accent);
  background: rgba(106, 140, 175, 0.1);
}

.dropzone-label {
  cursor: pointer;
  display: block;
  color: var(--text-muted);
  font-size: 1.1rem;
}

.error {
  color: var(--error);
  margin-top: 0.5rem;
}

/* Library */
.library {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.library-empty {
  color: var(--text-muted);
  text-align: center;
  padding: 2rem;
}

.book-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg-surface);
  padding: 1rem;
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.book-info h3 {
  font-size: 1rem;
  margin-bottom: 0.25rem;
}

.book-info p {
  color: var(--text-muted);
  font-size: 0.875rem;
}

.badge {
  display: inline-block;
  background: var(--bg-elevated);
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  margin-top: 0.25rem;
  margin-right: 0.25rem;
}

.btn-remove {
  background: none;
  border: none;
  color: var(--error);
  cursor: pointer;
  font-size: 1.2rem;
  padding: 0.25rem 0.5rem;
}

/* Reader */
.reader-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.reader-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.reader-header h2 {
  font-size: 1.1rem;
}

.progress {
  color: var(--text-muted);
  font-size: 0.875rem;
}

.reader-content {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  background: var(--bg-surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  line-height: 1.8;
  font-size: 1.125rem;
}

/* Karaoke */
.karaoke-text {
  font-size: 1.25rem;
  line-height: 2;
}

.word {
  transition: background-color 0.1s;
  border-radius: 2px;
}

.word-highlight {
  background: var(--accent-bright);
  color: var(--bg);
  border-radius: 2px;
  transition: background-color 0.05s;
}

/* Player Bar */
.player-bar {
  position: sticky;
  bottom: 0;
  background: var(--bg-surface);
  padding: 0.75rem 1rem;
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.player-controls {
  display: flex;
  gap: 0.5rem;
}

.player-controls button {
  background: var(--bg-elevated);
  border: none;
  color: var(--text);
  width: 44px;
  height: 44px;
  border-radius: 50%;
  cursor: pointer;
  font-size: 1.2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}

.player-controls button:hover:not(:disabled) {
  background: var(--accent);
}

.player-controls button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.player-options {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.voice-selector {
  background: var(--bg-elevated);
  color: var(--text);
  border: none;
  padding: 0.5rem;
  border-radius: var(--radius);
  cursor: pointer;
}

.speed-control {
  display: flex;
  gap: 0.125rem;
}

.speed-control button {
  background: var(--bg-elevated);
  border: none;
  color: var(--text-muted);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.75rem;
}

.speed-control button.active {
  background: var(--accent);
  color: var(--bg);
}
```

- [ ] **Step 10: Update main.tsx with global CSS import**

`src/main.tsx`:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 11: Verify dev server and type-check**

```bash
npx tsc --noEmit && npm run dev
```

Expected: Vite dev server running, app loads with dropzone visible

- [ ] **Step 12: Commit**

```bash
git add src/components/ src/App.tsx src/main.tsx src/styles/
git commit -m "feat: add all UI components (Dropzone, Library, ReaderView, KaraokeText, PlayerBar, VoiceSelector, SpeedControl)"
```

---

### Task 13: Integration — Prefetch Pipeline

**Files:**
- Modify: `src/agents/tts-client.ts`
- Modify: `src/components/PlayerBar.tsx`
- Create: `src/lib/prefetch.ts`

**Interfaces:**
- Consumes: `ExtractedDoc` from store, `fetchTTS` from TTS client
- Produces: Prefetch manager that pre-generates N+1 and N+2 chunks

- [ ] **Step 1: Create prefetch manager**

`src/lib/prefetch.ts`:
```typescript
import { fetchTTS } from '../agents/tts-client';
import { chunkParagraph } from '../agents/chunker';
import { usePlaybackStore } from '../store/playback-store';
import type { ExtractedDoc } from '../types';

const PREFETCH_AHEAD = 2;

export async function prefetchNext(doc: ExtractedDoc): Promise<void> {
  const store = usePlaybackStore.getState();
  const gen = store.generationId;
  const chapter = doc.chapters[store.chapterIndex];
  if (!chapter) return;

  for (let offset = 1; offset <= PREFETCH_AHEAD; offset++) {
    let targetChapter = store.chapterIndex;
    let targetParagraph = store.paragraphIndex + offset;

    // Handle chapter boundary
    while (targetParagraph >= doc.chapters[targetChapter].paragraphs.length) {
      targetParagraph -= doc.chapters[targetChapter].paragraphs.length;
      targetChapter++;
      if (targetChapter >= doc.chapters.length) return; // End of doc
    }

    const paragraph = doc.chapters[targetChapter]?.paragraphs[targetParagraph];
    if (!paragraph) continue;

    // Check if already cached or fetching
    const status = usePlaybackStore.getState().timingsByParagraph.get(paragraph.id);
    if (status && status.status !== 'idle') continue;

    // Mark as fetching
    usePlaybackStore.getState().setParagraphTiming(paragraph.id, { status: 'fetching' });

    // Chunk + fetch (fire and forget — don't block)
    const chunkResult = chunkParagraph({
      paragraphId: paragraph.id,
      paragraphText: paragraph.text,
      voiceId: store.voiceId,
      speed: store.speed,
      maxChunkChars: 500,
      strategy: 'sentence',
    });

    if (!chunkResult.success) continue;

    // Fetch all chunks for this paragraph
    (async () => {
      for (const chunk of chunkResult.data.chunks) {
        // Check generation — discard if stale
        if (usePlaybackStore.getState().generationId !== gen) return;
        const result = await fetchTTS(chunk);
        if (!result.success) return;
      }
      // Mark as ready (timings are stored in cache)
      usePlaybackStore.getState().setParagraphTiming(paragraph.id, { status: 'ready', timings: [] });
    })();
  }
}
```

- [ ] **Step 2: Wire prefetch into PlayerBar**

Add to `src/components/PlayerBar.tsx` in the `loadAndPlayParagraph` function, after successful load:

```typescript
import { prefetchNext } from '../lib/prefetch';

// ... after playerAgent.play() in loadAndPlayParagraph:
prefetchNext(doc).catch(() => { /* silent fail — prefetch is best-effort */ });
```

Also trigger prefetch on `nextParagraph` and `prevParagraph` handlers.

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/prefetch.ts src/components/PlayerBar.tsx
git commit -m "feat: add prefetch pipeline (N+1, N+2) with generationId invalidation"
```

---

### Task 14: End-to-End Testing

**Files:**
- Create: `test/e2e/manual-test.md`
- Create: `test/fixtures/sample.txt`

**Interfaces:**
- Consumes: full app running on localhost:5173 + Worker on localhost:8787

- [ ] **Step 1: Start both servers**

```bash
# Terminal 1 — Worker
cd worker && npx wrangler dev --local

# Terminal 2 — Frontend
npm run dev
```

- [ ] **Step 2: Manual test checklist**

Create `test/e2e/manual-test.md`:
```markdown
# Manual E2E Test Checklist

## 1. Import
- [ ] Drag a PDF → loads, shows reader view
- [ ] Drag an ePub → loads, shows reader view
- [ ] Drag unsupported file → shows error message
- [ ] Corrupt PDF → shows error message

## 2. TTS Playback
- [ ] Click Play → audio starts, word highlight appears
- [ ] Click Pause → audio stops, highlight freezes
- [ ] Click Play again → audio resumes from pause point
- [ ] Click Next → jumps to next paragraph, auto-plays
- [ ] Click Prev → jumps to previous paragraph, auto-plays

## 3. Karaoke
- [ ] Word highlight tracks with audio accurately (±100ms)
- [ ] Auto-scroll keeps active word visible
- [ ] No jank/stutter in highlight animation

## 4. Voice Selection
- [ ] Switch to Elvira (es-ES) → audio regenerates with new voice
- [ ] Switch to Aria (en-US) → audio regenerates
- [ ] Switch back to Dalia (es-MX) → audio regenerates

## 5. Speed Control
- [ ] Set 1.5x → audio plays faster
- [ ] Set 0.75x → audio plays slower
- [ ] Set back to 1.0x → normal speed

## 6. Cache
- [ ] Navigate back to a previously played paragraph → instant load (cache hit)
- [ ] Check IndexedDB in DevTools → audio entries present
- [ ] Change voice → old cache entries are not used (new hash)

## 7. Prefetch
- [ ] While playing paragraph N, check Network tab → N+1 and N+2 requests in flight
- [ ] When N finishes and N+1 starts → minimal delay (<200ms)

## 8. PWA
- [ ] Install prompt appears on iOS Safari
- [ ] App opens standalone after install
- [ ] Dark mode toggle works via system preference
```

- [ ] **Step 3: Run through the checklist**

Execute each test item manually. Document any failures.

- [ ] **Step 4: Commit**

```bash
git add test/
git commit -m "test: add manual E2E test checklist"
```

---

### Task 15: Deploy

**Files:**
- Modify: `vite.config.ts` (add worker URL for prod)
- Create: `.env.example`
- Create: `DEPLOYMENT.md`

- [ ] **Step 1: Deploy Cloudflare Worker**

```bash
cd worker
# Create R2 bucket (if not exists)
npx wrangler r2 bucket create speechify-tts-cache
# Deploy
npx wrangler deploy
```

Note the Worker URL (e.g., `https://speechify-tts.<your-subdomain>.workers.dev`)

- [ ] **Step 2: Configure frontend env**

`.env.example`:
```
VITE_WORKER_URL=https://speechify-tts.your-subdomain.workers.dev
```

```bash
cp .env.example .env
# Edit .env with actual Worker URL
```

- [ ] **Step 3: Build and deploy frontend to CF Pages**

```bash
npm run build
# Deploy via Wrangler Pages
npx wrangler pages deploy dist --project-name speechify-clone
```

- [ ] **Step 4: Create deployment docs**

`DEPLOYMENT.md`:
```markdown
# Deployment

## Worker (TTS API)
1. `cd worker`
2. Create R2 bucket: `npx wrangler r2 bucket create speechify-tts-cache`
3. Deploy: `npx wrangler deploy`
4. Note the URL

## Frontend (PWA)
1. Copy `.env.example` to `.env`
2. Set `VITE_WORKER_URL` to the Worker URL from step 1
3. `npm run build`
4. Deploy: `npx wrangler pages deploy dist --project-name speechify-clone`

## URLs
- Frontend: https://speechify-clone.pages.dev
- Worker: https://speechify-tts.<subdomain>.workers.dev
```

- [ ] **Step 5: Commit**

```bash
git add .env.example DEPLOYMENT.md vite.config.ts
git commit -m "docs: add deployment guide and env config"
```

---

## Summary

| Task | Description | Est. Complexity |
|---|---|---|
| 1 | Project Scaffolding | Low |
| 2 | Type Definitions | Low |
| 3 | Hash + Tokenizer Utils | Low |
| 4 | CF Worker (TTS endpoint) | High |
| 5 | Cache Layer (3-tier) | Medium |
| 6 | Extractor Agent (PDF+ePub) | High |
| 7 | Chunker Agent | Medium |
| 8 | TTS Client Agent | Medium |
| 9 | Zustand Stores | Medium |
| 10 | React Hooks | Low |
| 11 | Player Agent (Audio+rAF) | High |
| 12 | UI Components | High |
| 13 | Prefetch Pipeline | Medium |
| 14 | E2E Testing | Low |
| 15 | Deploy | Low |

**Total: 15 tasks, ~8-12 horas de implementación**
