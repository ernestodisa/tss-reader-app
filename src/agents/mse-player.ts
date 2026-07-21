import { WordTiming } from '../types';
import type {
  PlaybackEngine,
  WordChangeCallback,
  EndCallback,
  ErrorCallback,
  ChunkStartCallback,
  PlayBlockedCallback,
  QueuedChunkMeta,
} from './playback-engine';

// ── MseEngine: reproducción por stream continuo (MediaSource) ─────────────
// Motivación (Android): el motor clásico reasigna `audio.src` en cada frontera
// de chunk (swap síncrono en `ended`). Con la pantalla apagada / la app en
// background, Chrome Android BLOQUEA cargar media NUEVA, así que la cadena de
// chunks muere al cruzar la primera frontera. La solución es un ÚNICO `src`
// (un MediaSource) al que se le ANEXAN los MP3 al SourceBuffer por JS: Android
// sí permite eso en background porque no hay carga de media nueva.
//
// Los MP3 de Edge TTS se concatenan sin timestamps → SourceBuffer en modo
// 'sequence' (cada append se coloca justo detrás del anterior en la línea de
// tiempo). No hay `ended` entre chunks: la reproducción fluye continua y las
// fronteras se detectan por software comparando currentTime contra el offset
// acumulado de cada segmento anexado.
//
// DECISIONES de diseño (documentadas por requisito):
//  • RESET (load): se crea un MediaSource NUEVO por cada load() en vez de
//    abort+remove del buffer. Es más simple y descarta cualquier estado sucio.
//    load() solo ocurre en puntos de reinicio legítimos (arranque, next/prev,
//    salto de capítulo, recuperación por cambio de generación, skip por error)
//    — NUNCA en una frontera de chunk del camino feliz, así que la ventaja de
//    background del stream continuo se conserva donde importa.
//  • DURACIÓN/OFFSETS: no se confía en el header X-Duration (el upstream es
//    frágil). El offset de inicio/fin de cada segmento se deriva de los rangos
//    reales `sourceBuffer.buffered` al completar cada append. `durationMs` de
//    la interfaz se acepta pero se usa solo como pista de respaldo.
//  • QUOTA: ante QuotaExceededError se hace remove() de lo ya reproducido
//    (dejando un colchón) y se reintenta el append pendiente en el updateend.
//  • RE-BASE de timings: los timings de cada chunk son RELATIVOS a su inicio;
//    getCurrentPositionMs() resta el offset del segmento activo para devolver
//    ms relativos al chunk/párrafo actual (mismo contrato que el motor viejo).

interface Segment {
  paragraphId: string;
  timings: WordTiming[];
  /** null para el primer segmento de un load (arranque implícito, sin chunkStart). */
  meta: QueuedChunkMeta | null;
  /** Offset absoluto en la línea de tiempo del MediaSource (ms). */
  startMs: number;
  /** Fin absoluto (ms), derivado de buffered.end al completar el append. */
  endMs: number;
}

interface PendingAppend {
  buf: BufferSource;
  paragraphId: string;
  timings: WordTiming[];
  meta: QueuedChunkMeta | null;
}

const END_EPS_MS = 120; // margen para dar por alcanzado el fin del último segmento

function concatParts(parts: ArrayBuffer[]): ArrayBuffer {
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), off);
    off += p.byteLength;
  }
  return out.buffer;
}

export class MseEngine implements PlaybackEngine {
  private audio: HTMLAudioElement | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private _volume = 1;

  private wordCallback: WordChangeCallback | null = null;
  private endCallback: EndCallback | null = null;
  private errorCallback: ErrorCallback | null = null;
  private chunkStartCallback: ChunkStartCallback | null = null;
  private playBlockedCallback: PlayBlockedCallback | null = null;

  // Segmentos ya anexados (con offsets reales), y la cola de appends pendientes.
  private segments: Segment[] = [];
  private pending: PendingAppend[] = [];
  private activeIndex = 0;

  private _rafId = 0;
  private _hasCurrent = false; // hay un stream cargado (equivale a _currentParagraphId)
  private _tearingDown = false; // suprime el `error` espurio al desmontar el src
  private _removing = false; // el próximo updateend viene de un remove() (eviction)
  private _endFired = false; // el endCallback ya se disparó para el fin actual
  private _generation = 0; // token para ignorar sourceopen de MediaSources viejos

  private getAudio(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.setAttribute('playsinline', 'true');
      this.audio.volume = this._volume;
      // Un MP3 corrupto/indecodificable hace que el <audio> emita `error`; se
      // enruta a la recuperación del PlayerBar (reintentar/saltar), salvo que
      // estemos desmontando el src (error espurio de un removeAttribute+load).
      this.audio.addEventListener('error', () => {
        if (this._hasCurrent && !this._tearingDown) {
          cancelAnimationFrame(this._rafId);
          this.errorCallback?.();
        }
      });
      // CRÍTICO para background: requestAnimationFrame se CONGELA con la
      // pantalla apagada / pestaña oculta — si las fronteras solo se detectaran
      // en el rAF, en background nadie encolaría el siguiente chunk y el stream
      // moriría por inanición al drenar el buffer. `timeupdate` SÍ dispara en
      // background (~4x/seg): de aquí cuelga el avance de segmentos, el encolado
      // y el fin de stream. El rAF queda solo para la suavidad del karaoke.
      this.audio.addEventListener('timeupdate', () => {
        if (this._hasCurrent && this.audio) {
          this.checkProgress(this.audio.currentTime * 1000);
        }
      });
      // FIN por estancamiento: al agotarse el buffer (fin real del stream, p.ej.
      // cuando el párrafo siguiente no aportó chunks — separadores "• • •"), el
      // audio se congela unos ms ANTES del endMs calculado y timeupdate deja de
      // disparar → el umbral de fin jamás se alcanzaba y la reproducción quedaba
      // clavada en "playing" muda. `waiting`/`stalled` son la señal del propio
      // estancamiento: si no queda nada anexado ni pendiente por delante, ese
      // estancamiento ES el fin del stream.
      const onStall = () => this.endOnStall();
      this.audio.addEventListener('waiting', onStall);
      this.audio.addEventListener('stalled', onStall);
    }
    return this.audio;
  }

  load(
    paragraphId: string,
    mp3Parts: ArrayBuffer[],
    timings: WordTiming[],
    _durationMs?: number,
  ): void {
    // RESET: se derriba el stream anterior y se crea un MediaSource nuevo.
    this.teardownStream();
    this._hasCurrent = true;
    this._endFired = false;
    this.activeIndex = 0;

    const audio = this.getAudio();
    const gen = ++this._generation;
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.objectUrl = URL.createObjectURL(ms);
    audio.src = this.objectUrl;

    // El primer segmento entra a la cola de pendientes; se anexa en sourceopen.
    this.pending.push({ buf: concatParts(mp3Parts), paragraphId, timings, meta: null });

    ms.addEventListener(
      'sourceopen',
      () => {
        // Ignora sourceopen de un MediaSource ya reemplazado por otro load().
        if (this._generation !== gen || this.mediaSource !== ms) return;
        if (ms.sourceBuffers.length > 0) return;
        try {
          const sb = ms.addSourceBuffer('audio/mpeg');
          sb.mode = 'sequence';
          this.sourceBuffer = sb;
          sb.addEventListener('updateend', () => this.onUpdateEnd());
          sb.addEventListener('error', () => {
            if (this._hasCurrent && !this._tearingDown) this.errorCallback?.();
          });
          this.flush();
        } catch {
          if (this._hasCurrent) this.errorCallback?.();
        }
      },
      { once: true },
    );
  }

  play(): void {
    const audio = this.audio;
    if (!audio || !this._hasCurrent) return;
    // Un rechazo (autoplay/background) se notifica para que la UI quede en
    // pausa honesta en vez de "reproduciendo" muda.
    void audio.play().catch(() => this.playBlockedCallback?.());
    this.startTracking();
  }

  resume(): void {
    const audio = this.audio;
    if (!audio || !this._hasCurrent) return;
    void audio.play().catch(() => {
      /* sin gesto válido; se reintenta al tocar ▶ */
    });
    this.startTracking();
  }

  pause(): void {
    this.audio?.pause();
    cancelAnimationFrame(this._rafId);
  }

  queueNext(
    mp3Parts: ArrayBuffer[],
    timings: WordTiming[],
    meta: QueuedChunkMeta,
    _durationMs?: number,
  ): void {
    if (!this._hasCurrent) return;
    // ANEXAR el siguiente chunk al buffer SIN tocar play. Se coloca en cola de
    // pendientes (respeta el flag `updating`) y se procesa en cadena.
    this.pending.push({ buf: concatParts(mp3Parts), paragraphId: meta.paragraphId, timings, meta });
    this.flush();
  }

  /** Procesa la cola de appends respetando `updating` del SourceBuffer. */
  private flush(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.pending.length === 0) return;
    const next = this.pending[0];
    try {
      // Se deja en `pending[0]` hasta que updateend confirme el append.
      sb.appendBuffer(next.buf);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        // Buffer lleno: se libera lo ya reproducido y se reintenta en updateend.
        this.evictPlayed();
      } else if (this._hasCurrent) {
        this.errorCallback?.();
      }
    }
  }

  /** Libera del buffer los rangos ya reproducidos, dejando un colchón. */
  private evictPlayed(): void {
    const sb = this.sourceBuffer;
    const audio = this.audio;
    if (!sb || !audio || sb.updating) return;
    const KEEP_BEHIND = 10; // segundos a conservar por detrás del cursor
    const cur = audio.currentTime;
    if (cur <= KEEP_BEHIND) return; // aún no hay nada evictable
    try {
      this._removing = true;
      sb.remove(0, cur - KEEP_BEHIND);
    } catch {
      this._removing = false;
    }
  }

  private onUpdateEnd(): void {
    const sb = this.sourceBuffer;
    if (!sb) return;

    // Si el updateend viene de un remove() (eviction), solo reintenta el append.
    if (this._removing) {
      this._removing = false;
      this.flush();
      return;
    }

    const done = this.pending.shift();
    if (done) {
      const prevEnd = this.segments.length ? this.segments[this.segments.length - 1].endMs : 0;
      const bufEnd =
        sb.buffered.length > 0 ? sb.buffered.end(sb.buffered.length - 1) * 1000 : prevEnd;
      this.segments.push({
        paragraphId: done.paragraphId,
        timings: done.timings,
        meta: done.meta,
        startMs: prevEnd,
        endMs: Math.max(bufEnd, prevEnd),
      });
      // Llegó dato nuevo: el fin del stream ya no está alcanzado.
      this._endFired = false;
    }
    // Procesa el siguiente pendiente si lo hay.
    this.flush();
  }

  fullStop(): void {
    this.teardownStream();
  }

  /** Derriba el stream sin disparar callbacks (equivale al fullStop clásico). */
  private teardownStream(): void {
    cancelAnimationFrame(this._rafId);
    this._hasCurrent = false;
    this._endFired = false;
    this._removing = false;

    const audio = this.audio;
    if (audio) {
      // Suprime el `error` espurio que emite quitar el src + load().
      this._tearingDown = true;
      audio.pause();
      audio.removeAttribute('src');
      try {
        audio.load();
      } catch {
        /* no-op */
      }
      this._tearingDown = false;
    }

    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {
        /* ignora si no se puede cerrar limpiamente */
      }
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.segments = [];
    this.pending = [];
    this.activeIndex = 0;
  }

  setVolume(volume: number): void {
    this._volume = Math.max(0, Math.min(1, volume));
    if (this.audio) this.audio.volume = this._volume;
  }

  getVolume(): number {
    return this._volume;
  }

  getCurrentPositionMs(): number {
    // ms RELATIVOS al segmento (chunk) activo, igual que el motor clásico.
    if (!this._hasCurrent || !this.audio) return 0;
    const seg = this.segments[this.activeIndex];
    const posMs = this.audio.currentTime * 1000;
    const base = seg ? seg.startMs : 0;
    return Math.max(0, posMs - base);
  }

  destroy(): void {
    this.teardownStream();
    this.audio = null;
  }

  setWordChangeCallback(cb: WordChangeCallback): void {
    this.wordCallback = cb;
  }

  setEndCallback(cb: EndCallback): void {
    this.endCallback = cb;
  }

  setErrorCallback(cb: ErrorCallback): void {
    this.errorCallback = cb;
  }

  setChunkStartCallback(cb: ChunkStartCallback): void {
    this.chunkStartCallback = cb;
  }

  setPlayBlockedCallback(cb: PlayBlockedCallback): void {
    this.playBlockedCallback = cb;
  }

  // ── Progreso (fronteras + fin) — llamado desde timeupdate Y desde el rAF ──
  // En background solo corre vía timeupdate; en foreground ambos (el while y
  // los flags lo hacen idempotente).
  private checkProgress(posMs: number): void {
    // Avance de segmento activo al cruzar la frontera del siguiente segmento
    // YA anexado. Al cruzarla se dispara chunkStartCallback con su meta y se
    // re-basa el word tracking (los timings del nuevo segmento son relativos
    // a su propio inicio).
    while (
      this.activeIndex + 1 < this.segments.length &&
      posMs >= this.segments[this.activeIndex + 1].startMs
    ) {
      this.activeIndex += 1;
      this._endFired = false;
      const seg = this.segments[this.activeIndex];
      if (seg.meta) this.chunkStartCallback?.(seg.meta, seg.timings);
    }

    // Fin real del stream: se alcanzó el fin del último segmento anexado y no
    // hay nada pendiente por anexar. Equivale al `ended` sin cola del motor
    // clásico → endCallback (PlayerBar decide siguiente chunk o avance).
    const last = this.segments[this.segments.length - 1];
    if (
      last &&
      this.pending.length === 0 &&
      this.activeIndex === this.segments.length - 1 &&
      posMs >= last.endMs - END_EPS_MS &&
      !this._endFired
    ) {
      this._endFired = true;
      this.endCallback?.();
    }
  }

  /** Fin del stream detectado por estancamiento (`waiting`/`stalled`). */
  private endOnStall(): void {
    if (!this._hasCurrent || this._endFired) return;
    // Solo es fin si estamos en el ÚLTIMO segmento anexado y no hay appends
    // pendientes: un waiting a media stream (no debería ocurrir en modo
    // sequence) no debe disparar avances en falso.
    if (this.pending.length > 0) return;
    if (this.activeIndex !== this.segments.length - 1) return;
    if (this.segments.length === 0) return;
    this._endFired = true;
    this.endCallback?.();
  }

  // ── Karaoke por rAF (solo foreground; el progreso duro va por timeupdate) ─
  private startTracking(): void {
    cancelAnimationFrame(this._rafId);
    const tick = () => {
      if (!this._hasCurrent || !this.audio) return;
      const posMs = this.audio.currentTime * 1000;

      this.checkProgress(posMs);

      // Karaoke: índice de palabra relativo al segmento activo.
      const active = this.segments[this.activeIndex];
      if (active && active.timings.length > 0) {
        const rel = posMs - active.startMs;
        const idx = active.timings.findIndex(
          (t) => rel >= t.offsetMs && rel < t.offsetMs + t.durationMs,
        );
        if (idx >= 0) this.wordCallback?.(idx);
      }

      if (this._hasCurrent) {
        this._rafId = requestAnimationFrame(tick);
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }
}
