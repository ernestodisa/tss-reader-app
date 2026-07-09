# Manual E2E Test Checklist

> **Prerequisites:** Both servers running — Worker on `localhost:8787` and Vite dev server on `localhost:5173`.

## 0. Smoke Test

- [ ] App loads at http://localhost:5173 without errors
- [ ] Dropzone is visible with label "Arrastra un PDF o ePub aquí"
- [ ] No console errors on initial load
- [ ] File input accepts `.pdf` and `.epub` files

---

## 1. Import

- [ ] Click dropzone → file picker opens, accepts PDF
- [ ] Select `test/fixtures/sample.txt` → error: unsupported format (accepts only PDF/ePub)
- [ ] Drag a PDF file → loads, shows reader view with chapter title and paragraph text
- [ ] Drag an ePub file → loads, shows reader view
- [ ] Drag an unsupported file (e.g., `.jpg`) → shows error message
- [ ] Corrupt PDF (truncated/zero-byte) → shows error message

---

## 2. TTS Playback

- [ ] Reader view shows PlayerBar with ⏮ ▶ ⏭ buttons
- [ ] Click ▶ (Play) → audio starts, word highlight appears on current word
- [ ] Click ⏸ (Pause) → audio stops, highlight freezes at last word
- [ ] Click ▶ again → audio resumes from pause point
- [ ] Click ⏭ (Next) → jumps to next paragraph, auto-plays
- [ ] Click ⏮ (Prev) → jumps to previous paragraph, auto-plays
- [ ] While playing, progress indicator shows (chapter/paragraph counters update)

---

## 3. Karaoke Word Highlighting

- [ ] Word highlight tracks with audio accurately (highlight moves word-by-word)
- [ ] Highlighted word is visually distinct (CSS class `word-highlight` applied)
- [ ] Auto-scroll keeps the active word visible in the viewport
- [ ] No jank/stutter in highlight animation during playback

---

## 4. Voice Selection

- [ ] Voice selector dropdown is visible in the PlayerBar
- [ ] Default voice is "Dalia (es-MX)"
- [ ] Selector shows 3 voices: Dalia (es-MX), Elvira (es-ES), Aria (en-US)
- [ ] Switch to Elvira (es-ES) → audio regenerates with new voice on next play
- [ ] Switch to Aria (en-US) → audio regenerates
- [ ] Switch back to Dalia (es-MX) → audio regenerates
- [ ] Voice change triggers new generation (generationId increments)

---

## 5. Speed Control

- [ ] Speed control buttons are visible in the PlayerBar
- [ ] 7 speed options displayed: 0.5x, 0.75x, 1.0x, 1.25x, 1.5x, 1.75x, 2.0x
- [ ] Default speed is 1.0x (button highlighted as active)
- [ ] Click 1.5x → button becomes active, audio plays faster on next play
- [ ] Click 0.75x → audio plays slower
- [ ] Click 1.0x → audio returns to normal speed
- [ ] Speed change triggers new generation

---

## 6. Cache (TieredCache + IndexedDB)

- [ ] Play paragraph N until it finishes
- [ ] Navigate away (Next), then back (Prev) to the same paragraph
- [ ] Previous paragraph audio loads instantly (cache hit — no network request)
- [ ] Open DevTools → Application → IndexedDB → check for audio entries
- [ ] Change voice → old cache entries are not used (new hash = new generation)
- [ ] Cache survives page reload (IndexedDB persistence)

---

## 7. Prefetch

- [ ] Open DevTools → Network tab
- [ ] Start playing paragraph N
- [ ] Observe requests for paragraphs N+1 and N+2 in flight (prefetch)
- [ ] When paragraph N finishes and N+1 starts → minimal delay (<200ms)
- [ ] Prefetch requests fire silently — failures do not break playback

---

## 8. PWA

- [ ] `manifest.json` is served and valid
- [ ] Service worker registers successfully (check DevTools → Application → Service Workers)
- [ ] Install prompt appears on supported browsers (Chrome: address bar icon)
- [ ] App opens in standalone mode after install (`display: standalone`)
- [ ] Dark mode: `theme_color` and `background_color` set to `#1a1a1a`
- [ ] Icons: `/icon-192.png` and `/icon-512.png` referenced in manifest

---

## 9. Edge Cases & Resilience

- [ ] **Empty document**: importing a PDF with no extractable text → appropriate error
- [ ] **Single paragraph**: document with only 1 paragraph → Prev/Next buttons disabled at boundaries
- [ ] **Worker offline**: stop Worker (port 8787), try Play → shows error message (network error)
- [ ] **Rate limiting**: rapid voice/speed changes → 429 responses handled gracefully with retry
- [ ] **Page reload during playback**: refresh browser → app restores to initial state cleanly
- [ ] **Multiple rapid clicks**: spam Play/Pause/Next → no crashes, no duplicate audio

---

## Test Results Summary

| Section | Status | Notes |
|---------|--------|-------|
| 0. Smoke Test | ⬜ | |
| 1. Import | ⬜ | |
| 2. TTS Playback | ⬜ | |
| 3. Karaoke | ⬜ | |
| 4. Voice Selection | ⬜ | |
| 5. Speed Control | ⬜ | |
| 6. Cache | ⬜ | |
| 7. Prefetch | ⬜ | |
| 8. PWA | ⬜ | |
| 9. Edge Cases | ⬜ | |

**Tester:** _________ &nbsp;&nbsp; **Date:** _________ &nbsp;&nbsp; **Build/Commit:** _________
