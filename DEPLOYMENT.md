# Deployment Guide

This guide covers deploying both the **TTS Worker** (Cloudflare Workers) and the **Frontend PWA** (Cloudflare Pages) for Folio.

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npx wrangler login`)

---

## 1. Deploy the TTS Worker

The Worker (`worker/`) handles text-to-speech requests via Edge TTS and caches
results in an R2 bucket. It also serves progress **sync**.

> **Architecture note (read before deploying).** In production this Worker is
> **not** publicly reachable: `worker/wrangler.toml` sets `workers_dev = false`
> and `preview_urls = false` on purpose. All production traffic enters through
> the **Pages Function** at `/api/*` (same-origin, behind Cloudflare Access),
> which reuses the Worker's logic and R2 bucket. Deploying the standalone Worker
> is therefore optional — it exists as shared source and as the **local-dev
> backend** (`wrangler dev`). Do **not** point the frontend at a `workers.dev`
> URL: that path bypasses Access, so identity sync (`/sync/me`) fails with a
> silent `401` because no `X-Verified-Email` header is present. See §2.

### 1.1 Authenticate Wrangler

```bash
npx wrangler login
```

### 1.2 The R2 Bucket

Both `worker/wrangler.toml` and the root `wrangler.toml` (Pages) bind the
`TTS_CACHE` binding to the bucket **`speechify-tts-cache`**. That is the real,
production bucket name — it is kept deliberately (it holds live TTS cache + user
sync data; renaming would require migrating R2 objects). A **historical** name
`folio-tts-cache` appears in older notes; it is **not** used by anything — do not
create it.

If the bucket does not exist yet:

```bash
npx wrangler r2 bucket create speechify-tts-cache
```

> If the bucket already exists, this command errors safely — skip it.

### 1.3 Deploy the Worker (optional — dev/source only)

```bash
cd worker
npx wrangler deploy
```

Because `workers_dev = false`, the deployed Worker has **no public URL**. It is
reachable only internally; production goes through `/api/*` (§2).

### 1.4 Verify the Worker

Verify locally against `wrangler dev` (see §4), or verify the production path via
the Pages Function once the frontend is deployed:

```bash
# Local (wrangler dev on :8787)
curl -X POST http://localhost:8787/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world","voiceId":"en-US-AriaNeural","speed":1.0,"format":"mp3"}' \
  --output test.mp3
```

### 1.5 Configure Optional TTS Engines (ElevenLabs / OpenAI)

The Worker supports three TTS engines: **edge** (default, no key required),
**elevenlabs**, and **openai**. The last two need API keys, stored as Worker
secrets (never committed, never placed in `wrangler.toml`):

```bash
cd worker
npx wrangler secret put ELEVENLABS_API_KEY   # paste your ElevenLabs key when prompted
npx wrangler secret put OPENAI_API_KEY        # paste your OpenAI key when prompted
```

To remove a key later: `npx wrangler secret delete OPENAI_API_KEY`.

When a key is absent, that engine reports `enabled: false` on `GET /engines`,
and any `/tts` request naming it returns `400 engine_not_configured`. Edge always
works. Redeploy is **not** required after adding a secret — it takes effect on
the next request.

### 1.6 API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/tts` | Synthesize speech. Body: `{ text, voiceId, speed, format, engine? }`. `engine` is `"edge"` (default), `"elevenlabs"`, or `"openai"`. Returns audio bytes plus `X-Words`, `X-Duration`, `X-Chunk-Id`, `X-Cache` headers. |
| `GET` | `/engines` | Lists engines and representative voices: `{ engines: [{ id, enabled, voices: [{ id, name, language, gender }] }] }`. `enabled` reflects whether the engine's key is configured. |
| `GET` | `/sync/{code}` | Fetch previously saved progress for `{code}`. `404` if none. |
| `PUT` | `/sync/{code}` | Save a JSON progress payload (≤ 64KB) under `{code}`. |

**Engine timing notes:** ElevenLabs uses the `with-timestamps` endpoint and
returns real word timings (derived from char-level alignment). OpenAI's speech
API returns **no** timings, so the Worker generates synthetic word timings
proportional to word length over an *estimated* duration (~15 chars/sec adjusted
by speed) — karaoke highlighting may drift slightly on long chunks.

Example — list engines and use OpenAI (against the local dev Worker):

```bash
curl http://localhost:8787/engines

curl -X POST http://localhost:8787/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hola mundo","voiceId":"nova","speed":1.0,"format":"mp3","engine":"openai"}' \
  --output test-openai.mp3
```

### 1.7 Progress Sync

There are two sync paths:

- **Identity sync — `GET`/`PUT /sync/me` (production).** The authenticated path.
  The Pages Function validates the Cloudflare Access JWT and injects an
  `X-Verified-Email` header; the Worker keys storage under `sync/u/{email}`. The
  client never sets that header, and the standalone Worker rejects the request
  with `401` when it is absent — which is exactly why the frontend must go through
  `/api/*` and **not** a `workers.dev` URL. In **local dev** (no Access in front),
  set `DEV_FAKE_EMAIL` in `worker/.dev.vars` so `/sync/me` resolves to a stub
  identity (see §4).
- **Code sync — `GET`/`PUT /sync/{code}` (fallback, unauthenticated).** Lets a
  user carry progress by sharing an 8–32 char code, stored under `sync/{code}`.

> **Security tradeoff (code sync only):** there is **no authentication** on the
> `{code}` path. Anyone who knows a code can read or overwrite its payload —
> treat the code like a bookmark, not a credential, and never store sensitive
> data in the synced payload.

```bash
# Save progress by code (local dev Worker)
curl -X PUT http://localhost:8787/sync/mycode123 \
  -H "Content-Type: application/json" \
  -d '{"documentId":"abc","chunkIndex":42}'

# Restore progress by code
curl http://localhost:8787/sync/mycode123
```

---

## 2. Deploy the Frontend PWA

The frontend is a React + Vite PWA deployed to Cloudflare Pages.

### 2.1 Configure Environment

```bash
# From the project root
cp .env.example .env
```

Leave `VITE_WORKER_URL` at its default **`/api`** — the frontend talks to the
backend over a same-origin relative path in **every** environment:

```
VITE_WORKER_URL=/api
```

- **Production:** the Pages Function `functions/api/[[path]].ts` serves `/api/*`,
  behind Cloudflare Access. Access validates the JWT and forwards a verified
  `X-Verified-Email` to the Worker logic, so identity sync works.
- **Development:** the Vite dev server proxies `/api/*` → `http://localhost:8787`
  (local Worker), stripping the `/api` prefix — same-origin, no CORS.

> **Do not** set `VITE_WORKER_URL` to a `workers.dev` URL. That bypasses Access
> (no `X-Verified-Email`), so `/sync/me` returns a silent `401` and cross-device
> sync is dead — and in dev, a cross-origin `credentials: 'include'` request
> against `Access-Control-Allow-Origin: *` is aborted by the browser (the
> `ERR_FAILED` seen in QA). The Pages deploy already binds the R2 bucket and hosts
> the Access-protected Function, so `/api` is all the frontend needs.

### 2.2 Build the Frontend

```bash
npm run build
```

This runs `tsc -b && vite build` and outputs to the `dist/` directory.

### 2.3 Deploy to Cloudflare Pages

```bash
npx wrangler pages deploy dist --project-name tss-reader-app
```

> If the `tss-reader-app` Pages project doesn't exist yet, run `npx wrangler pages project create tss-reader-app` first.

### 2.4 Verify the Frontend

Open the deployed URL in your browser:

```
https://tss-reader-app.pages.dev
```

Or use the custom domain you've configured in Cloudflare Pages settings.

---

## 3. Environment Variables Reference

| Variable | Where | Required | Default | Description |
|---|---|---|---|---|
| `VITE_WORKER_URL` | frontend (`.env`) | No | `/api` | Same-origin API base for prod **and** dev. Keep as `/api`. |
| `DEV_FAKE_EMAIL` | worker (`worker/.dev.vars`) | Dev only | — | Stub identity for `/sync/me` when running `wrangler dev` without Access in front. **Never** set in production. |

All `VITE_`-prefixed environment variables are bundled at build time by Vite —
changes require a rebuild and redeploy. `worker/.dev.vars` is git-ignored (see
`worker/.dev.vars.example`); worker secrets (ElevenLabs/OpenAI keys) go through
`wrangler secret put`, never in `wrangler.toml` or `.dev.vars` committed to git.

---

## 4. Local Development

For local development, you can run both services side by side:

```bash
# One-time: give the local Worker a dev identity for /sync/me
cd worker && cp .dev.vars.example .dev.vars && cd ..   # sets DEV_FAKE_EMAIL

# Terminal 1 — Start the Worker locally
cd worker
npx wrangler dev

# Terminal 2 — Start the Vite dev server
cd ..
npm run dev
```

The Vite dev server runs on `http://localhost:5173` and the Worker on
`http://localhost:8787`. The frontend calls the relative path `/api/*`, and the
Vite proxy (`vite.config.ts`) forwards it to the local Worker, stripping the
`/api` prefix — the same rewrite the production Pages Function applies. This keeps
dev same-origin (no CORS) and identical to prod.

Because there is no Cloudflare Access in front locally, the Worker reads
`DEV_FAKE_EMAIL` from `worker/.dev.vars` as the verified identity so that
`/sync/me` works in dev instead of returning `401`. Never define `DEV_FAKE_EMAIL`
in production.

> **Note:** R2 buckets are not available in local development mode by default. The Worker's in-memory cache layer will still function.

---

## 5. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Pages                                           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Frontend PWA (React + Vite)                          │  │
│  │  • EPUB/PDF extraction (client-side)                  │  │
│  │  • Chunking pipeline                                  │  │
│  │  • Audio player with karaoke highlighting             │  │
│  │  • 3-tier client cache (Memory → IndexedDB → /api)    │  │
│  └───────────────────────┬───────────────────────────────┘  │
│                          │ same-origin /api/*               │
│  ┌───────────────────────▼───────────────────────────────┐  │
│  │  Pages Function  functions/api/[[path]].ts            │  │
│  │  • Behind Cloudflare Access (JWT validation)          │  │
│  │  • Injects X-Verified-Email → Worker logic            │  │
│  │  • Reuses worker/ TTS + sync code, binds R2           │  │
│  └───────────────────────┬───────────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                           │  (standalone Worker: dev/source only,
                           │   workers_dev=false, not public)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare R2                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  speechify-tts-cache   (binding: TTS_CACHE)           │  │
│  │  • Cached TTS audio (MP3/OGG) keyed by content hash   │  │
│  │  • Word timing metadata                               │  │
│  │  • Identity sync under sync/u/{email}                 │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. Troubleshooting

### "Bucket not found" error during Worker/Pages deploy
Make sure the R2 bucket exists (step 1.2). Both `worker/wrangler.toml` and the
root `wrangler.toml` bind `TTS_CACHE` to **`speechify-tts-cache`** — the real
name. Ignore any older reference to `folio-tts-cache`; nothing uses it.

### Frontend shows "network_error" for TTS requests
- Confirm `VITE_WORKER_URL` is `/api` (the default) — **not** a `workers.dev` URL.
- In dev, confirm the local Worker is up (`wrangler dev` on :8787) so the Vite
  `/api` proxy has a target: `curl http://localhost:8787/tts`.
- In prod, confirm the Pages Function is deployed and Access is configured.
- Rebuild after changing `.env`: `npm run build`.

### Cross-device sync silently does nothing / `/sync/me` returns 401
- The frontend must reach the backend via `/api/*` (behind Access), not a
  `workers.dev` URL — only the Pages Function injects the `X-Verified-Email` the
  Worker requires.
- In dev, set `DEV_FAKE_EMAIL` in `worker/.dev.vars` (copy `worker/.dev.vars.example`);
  without it, `/sync/me` returns `401` locally by design.

### Rate limiting (429 errors)
Edge TTS enforces rate limits. The client has built-in exponential backoff and retry logic. If you hit limits consistently, consider:
- Adding a queue system in the Worker
- Using a paid Azure Cognitive Services key instead of the free Edge TTS

### Icons not showing on installed PWA
- Verify `icon-192.png` and `icon-512.png` exist in `public/`
- The icons are configured in `vite.config.ts` via `vite-plugin-pwa`
- After deploying, clear the PWA cache and reinstall
