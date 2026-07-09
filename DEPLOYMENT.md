# Deployment Guide

This guide covers deploying both the **TTS Worker** (Cloudflare Workers) and the **Frontend PWA** (Cloudflare Pages) for the Speechify Clone.

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npx wrangler login`)

---

## 1. Deploy the TTS Worker

The Worker handles text-to-speech requests via Edge TTS and caches results in an R2 bucket.

### 1.1 Authenticate Wrangler

```bash
npx wrangler login
```

### 1.2 Create the R2 Bucket

```bash
cd worker
npx wrangler r2 bucket create speechify-tts-cache
```

> If the bucket already exists, this command will error safely — you can skip it.

### 1.3 Deploy the Worker

```bash
npx wrangler deploy
```

After deployment, note the Worker URL. It will look like:

```
https://speechify-tts.<your-subdomain>.workers.dev
```

### 1.4 Verify the Worker

```bash
curl -X POST https://speechify-tts.<your-subdomain>.workers.dev/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world","voiceId":"en-US-AriaNeural","speed":1.0,"format":"mp3"}' \
  --output test.mp3
```

---

## 2. Deploy the Frontend PWA

The frontend is a React + Vite PWA deployed to Cloudflare Pages.

### 2.1 Configure Environment

```bash
# From the project root
cp .env.example .env
```

Edit `.env` and set `VITE_WORKER_URL` to the Worker URL from step 1.3:

```
VITE_WORKER_URL=https://speechify-tts.<your-subdomain>.workers.dev
```

### 2.2 Build the Frontend

```bash
npm run build
```

This runs `tsc -b && vite build` and outputs to the `dist/` directory.

### 2.3 Deploy to Cloudflare Pages

```bash
npx wrangler pages deploy dist --project-name speechify-clone
```

> If the `speechify-clone` Pages project doesn't exist yet, run `npx wrangler pages project create speechify-clone` first.

### 2.4 Verify the Frontend

Open the deployed URL in your browser:

```
https://speechify-clone.pages.dev
```

Or use the custom domain you've configured in Cloudflare Pages settings.

---

## 3. Environment Variables Reference

| Variable | Required | Default (dev) | Description |
|---|---|---|---|
| `VITE_WORKER_URL` | Yes | `http://localhost:8787` | URL of the deployed TTS Worker |

All `VITE_`-prefixed environment variables are bundled at build time by Vite. Changes require a rebuild and redeploy.

---

## 4. Local Development

For local development, you can run both services side by side:

```bash
# Terminal 1 — Start the Worker locally
cd worker
npx wrangler dev

# Terminal 2 — Start the Vite dev server
cd ..
npm run dev
```

The Vite dev server defaults to `http://localhost:5173` and the Worker to `http://localhost:8787`. The frontend automatically connects to the local Worker because `VITE_WORKER_URL` defaults to `http://localhost:8787` in the code when no env variable is set.

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
│  │  • 3-tier client cache (Memory → IndexedDB → Worker)  │  │
│  └───────────────────────┬───────────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                           │ HTTPS
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Workers                                         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  TTS Worker (speechify-tts)                           │  │
│  │  • POST /tts — Text-to-speech conversion              │  │
│  │  • Edge TTS multi-engine (Azure + Browser)            │  │
│  │  • SSML builder for improved prosody                  │  │
│  │  • R2-based persistent cache                          │  │
│  └───────────────────────┬───────────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare R2                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  speechify-tts-cache                                  │  │
│  │  • Cached TTS audio (MP3/OGG) keyed by content hash   │  │
│  │  • Word timing metadata                               │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. Troubleshooting

### "Bucket not found" error during Worker deploy
Make sure you created the R2 bucket first (step 1.2). The `wrangler.toml` binds to `speechify-tts-cache`.

### Frontend shows "network_error" for TTS requests
- Verify `VITE_WORKER_URL` in `.env` matches the deployed Worker URL
- Rebuild after changing `.env`: `npm run build`
- Check that the Worker is running: `curl <WORKER_URL>/tts`

### Rate limiting (429 errors)
Edge TTS enforces rate limits. The client has built-in exponential backoff and retry logic. If you hit limits consistently, consider:
- Adding a queue system in the Worker
- Using a paid Azure Cognitive Services key instead of the free Edge TTS

### Icons not showing on installed PWA
- Verify `icon-192.png` and `icon-512.png` exist in `public/`
- The icons are configured in `vite.config.ts` via `vite-plugin-pwa`
- After deploying, clear the PWA cache and reinstall
