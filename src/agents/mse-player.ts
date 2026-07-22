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

// B3: red de seguridad, NO el camino principal de fin. El fin sin truncado lo
// confirma el evento `waiting`/`stalled` (endOnStall), que dispara EXACTO cuando
// el buffer se drena (posMs ≈ endMs real, cero truncado audible). Este EPS solo
// cubre el caso en que `waiting` no llegue (algunos motores no lo emiten fiable)
// o el foreground, donde el rAF muestrea denso y podría cruzar el umbral ~1
// frame antes del drenado. Bajarlo de 120→24 ms recorta el truncado a un valor
// inaudible cuando esta red de seguridad sí se activa.
const END_EPS_MS = 24;

// M5/M6: colchón de datos a conservar por detrás del cursor, tanto para evictar
// el SourceBuffer (segundos) como para podar las entradas de `segments`.
const KEEP_BEHIND_SEC = 10;
const KEEP_BEHIND_MS = KEEP_BEHIND_SEC * 1000;

// Sin elemento => se trata como "en pausa" (no hay reproducción avanzando).
function audioPaused(audio: HTMLAudioElement | null): boolean {
  return !audio || audio.paused;
}

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
  // A4: los errores del ELEMENTO se suprimen desde el INICIO del teardown hasta
  // que el stream NUEVO da señal de vida (primer updateend exitoso). El flag
  // síncrono anterior (`_tearingDown`) no podía atrapar el `error` espurio, que
  // llega como tarea asíncrona DESPUÉS de que load() ya puso _hasCurrent=true.
  private _errorsSuppressed = false;
  private _removing = false; // el próximo updateend viene de un remove() (eviction)
  private _endFired = false; // el endCallback ya se disparó para el fin actual
  private _generation = 0; // token para ignorar sourceopen de MediaSources viejos
  // A5: hay ≥1 fetch en vuelo que alimentará ESTE stream (lo fija PlayerBar vía
  // setExpectingMore). Un underrun con esto en true NO es fin de stream.
  private _expectingMore = false;
  // M5: la última QuotaExceeded ocurrió en pausa; el flush se difiere hasta
  // resume/play (en pausa el cursor no avanza y evictar+reintentar giraría en
  // vacío → livelock).
  private _flushDeferred = false;
  // M5: temporizador de reintento del flush cuando la eviction no pudo iniciar
  // un remove (deja pending[0] sin updateend que lo destrabe → deadlock).
  private _flushRetryTimer = 0;

  private getAudio(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.setAttribute('playsinline', 'true');
      this.audio.volume = this._volume;
      // Un MP3 corrupto/indecodificable hace que el <audio> emita `error`; se
      // enruta a la recuperación del PlayerBar (reintentar/saltar), salvo que
      // estemos en la ventana de teardown→stream-nuevo-vivo (A4): el propio
      // removeAttribute('src')+load() emite un `error` espurio como tarea
      // asíncrona que llegaría cuando _hasCurrent ya volvió a ser true. Los
      // fallos REALES (fetch fallido, appendBuffer que lanza, error del
      // SourceBuffer) reportan por su propia vía y NO dependen de este evento,
      // así que suprimirlo aquí no deja al usuario colgado.
      this.audio.addEventListener('error', () => {
        if (this._hasCurrent && !this._errorsSuppressed) {
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
          // M7: se captura la generación y la referencia del SourceBuffer al
          // registrar los handlers; un `updateend`/`error` rezagado del stream
          // viejo (abort por detach) queda descartado por el guard de onUpdateEnd/
          // onSourceBufferError en vez de consumir pending del stream nuevo.
          sb.addEventListener('updateend', () => this.onUpdateEnd(gen, sb));
          sb.addEventListener('error', () => this.onSourceBufferError(gen, sb));
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
    this.resumeDeferredFlush();
  }

  resume(): void {
    const audio = this.audio;
    if (!audio || !this._hasCurrent) return;
    void audio.play().catch(() => {
      /* sin gesto válido; se reintenta al tocar ▶ */
    });
    this.startTracking();
    this.resumeDeferredFlush();
  }

  /**
   * M5: al reanudar, el cursor volverá a avanzar y ya se puede evictar/anexar.
   * Si una QuotaExceeded en pausa dejó el append diferido, se retoma aquí.
   */
  private resumeDeferredFlush(): void {
    if (this._flushDeferred) {
      this._flushDeferred = false;
      this.flush();
    }
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
        // M5 (livelock en pausa): en pausa el cursor no avanza, así que evictar
        // y reintentar ahora giraría remove/append en vacío quemando CPU. Se
        // DIFIERE el flush hasta resume()/play() (donde el cursor volverá a
        // avanzar y habrá algo evictable). resumeDeferredFlush lo retoma.
        if (audioPaused(this.audio)) {
          this._flushDeferred = true;
          return;
        }
        // Buffer lleno reproduciendo: se libera lo ya reproducido y se reintenta
        // el append en el updateend del remove.
        const started = this.evictPlayed();
        // M5 (deadlock): si la eviction NO pudo iniciar un remove (poco
        // reproducido: cur ≤ colchón, o remove lanzó), no habrá updateend que
        // destrabe pending[0]. Se reprograma el flush con backoff corto en vez
        // de dejar el append huérfano; al avanzar el cursor la eviction sí podrá.
        if (!started) this.scheduleFlushRetry();
      } else if (this._hasCurrent) {
        this.errorCallback?.();
      }
    }
  }

  /**
   * Libera del buffer los rangos ya reproducidos, dejando un colchón.
   * Devuelve true si INICIÓ un remove (su updateend reintentará el flush);
   * false si no había nada evictable o el remove lanzó (el llamador decide el
   * reintento — ver flush()/scheduleFlushRetry, M5).
   */
  private evictPlayed(): boolean {
    const sb = this.sourceBuffer;
    const audio = this.audio;
    if (!sb || !audio || sb.updating) return false;
    const cur = audio.currentTime;
    if (cur <= KEEP_BEHIND_SEC) return false; // aún no hay nada evictable
    try {
      this._removing = true;
      sb.remove(0, cur - KEEP_BEHIND_SEC);
      return true;
    } catch {
      this._removing = false;
      return false;
    }
  }

  /**
   * M6: eviction PROACTIVA del SourceBuffer (no esperar al QuotaExceededError).
   * Corre al cruzar una frontera de segmento (throttle natural: ~1 vez por
   * chunk). El manejo de quota en flush() queda como respaldo.
   */
  private proactiveEvict(): void {
    const sb = this.sourceBuffer;
    const audio = this.audio;
    if (!sb || !audio || sb.updating) return;
    if (this.pending.length > 0) return; // no interrumpir la cadena de appends
    if (audioPaused(audio)) return; // en pausa el cursor no avanza
    const cur = audio.currentTime;
    if (cur <= KEEP_BEHIND_SEC) return;
    if (sb.buffered.length === 0) return;
    const start = sb.buffered.start(0);
    // Nada nuevo por evictar si el inicio del buffer ya está en el colchón.
    if (cur - KEEP_BEHIND_SEC <= start + 0.5) return;
    try {
      this._removing = true;
      sb.remove(0, cur - KEEP_BEHIND_SEC);
    } catch {
      this._removing = false;
    }
  }

  /**
   * M6: poda las entradas de `segments` completamente reproducidas y más atrás
   * que el colchón. Los offsets (startMs/endMs) son ABSOLUTOS en la línea de
   * tiempo del MediaSource y NO cambian al podar; solo se resta del activeIndex
   * el número de entradas eliminadas del frente para que todos los sitios que
   * indexan `segments` (checkProgress, getCurrentPositionMs, startTracking,
   * onUpdateEnd, endOnStall) sigan apuntando al mismo objeto.
   */
  private pruneSegments(): void {
    const audio = this.audio;
    if (!audio || this.activeIndex <= 0) return;
    const cutoff = audio.currentTime * 1000 - KEEP_BEHIND_MS;
    let n = 0;
    // Prefijo contiguo de segmentos ya drenados; nunca poda el activo ni futuros.
    while (n < this.activeIndex && this.segments[n] && this.segments[n].endMs < cutoff) {
      n += 1;
    }
    if (n > 0) {
      this.segments.splice(0, n);
      this.activeIndex -= n;
    }
  }

  /** M5: reprograma el flush si la eviction no pudo destrabar pending[0]. */
  private scheduleFlushRetry(): void {
    if (this._flushRetryTimer) return;
    this._flushRetryTimer = (setTimeout(() => {
      this._flushRetryTimer = 0;
      this.flush();
    }, 250) as unknown) as number;
  }

  private onUpdateEnd(gen: number, sb: SourceBuffer): void {
    // M7: descarta updateend rezagados de un stream ya reemplazado (abort por
    // detach): consumir aquí pending.shift() del stream nuevo empujaría un
    // segmento fantasma → posición/karaoke corruptos desde el arranque.
    if (this._generation !== gen || this.sourceBuffer !== sb) return;

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
      // A4: el primer append genuino confirma que el stream NUEVO está vivo →
      // se levanta la supresión de errores del elemento. Cualquier `error`
      // espurio del teardown anterior ya llegó (bastante antes de completar
      // este append), y un error REAL de aquí en adelante (decodificación al
      // reproducir) sí debe reportarse.
      this._errorsSuppressed = false;
      // A5 (recuperación de underrun): si el elemento estaba drenado esperando
      // este chunk y seguimos en intención de reproducir (no en pausa del
      // usuario), un `play()` lo reanuda. Con `paused===false` ya estaba
      // sonando (el estancamiento no pausa) y play() es no-op inofensivo; solo
      // rescata el caso en que el motor sí dejó el elemento pausado por stall.
      if (this._hasCurrent && this.audio && !this.audio.paused) {
        void this.audio.play().catch(() => {
          /* sin datos suficientes aún o sin gesto; reintenta al próximo append */
        });
      }
    }
    // Procesa el siguiente pendiente si lo hay.
    this.flush();
  }

  /** M7: error del SourceBuffer, ignorado si es de un stream ya reemplazado. */
  private onSourceBufferError(gen: number, sb: SourceBuffer): void {
    if (this._generation !== gen || this.sourceBuffer !== sb) return;
    // Un error del SourceBuffer VIGENTE es un fallo real de anexado (no el
    // `error` espurio del elemento que cubre _errorsSuppressed): se reporta.
    if (this._hasCurrent) this.errorCallback?.();
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
    this._flushDeferred = false;
    if (this._flushRetryTimer) {
      clearTimeout(this._flushRetryTimer);
      this._flushRetryTimer = 0;
    }

    const audio = this.audio;
    if (audio) {
      // A4: se ENCIENDE la supresión de errores del elemento aquí y NO se apaga
      // en este bloque síncrono: el `error` espurio de removeAttribute('src')+
      // load() llega asíncrono, después de que load() ya puso _hasCurrent=true.
      // La supresión se levanta al primer updateend del stream nuevo (ver
      // onUpdateEnd), que es estrictamente posterior a la ventana del espurio.
      this._errorsSuppressed = true;
      audio.pause();
      audio.removeAttribute('src');
      try {
        audio.load();
      } catch {
        /* no-op */
      }
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
    const rel = Math.max(0, posMs - base);
    // B4: PlayerBar usa `> 0` como "hay audio cargado". Mientras _hasCurrent
    // siga true HAY stream cargado aunque currentTime aún sea 0 (stream recién
    // montado, primer append en vuelo). Devolver 0 aquí se malinterpretaría
    // como "nada cargado" y un pausa+play rápido dispararía un doble arranque.
    // Se garantiza ≥1 (el valor exacto no se usa: PlayerBar solo lo compara con
    // 0). Tras el fin natural _hasCurrent es false (A6) → 0 correcto = recargar.
    return rel > 0 ? rel : 1;
  }

  // A5: PlayerBar avisa cuándo hay un fetch en vuelo que alimentará este stream.
  setExpectingMore(expecting: boolean): void {
    this._expectingMore = expecting;
  }

  destroy(): void {
    this.teardownStream();
    // A2: mismo contrato que el motor clásico — anula los callbacks para que un
    // load posterior sobre el singleton (fetch en vuelo de un PlayerBar ya
    // desmontado) no reviva la cadena vía callbacks huérfanos.
    this.wordCallback = null;
    this.endCallback = null;
    this.errorCallback = null;
    this.chunkStartCallback = null;
    this.playBlockedCallback = null;
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
    const before = this.activeIndex;
    while (
      this.activeIndex + 1 < this.segments.length &&
      posMs >= this.segments[this.activeIndex + 1].startMs
    ) {
      this.activeIndex += 1;
      this._endFired = false;
      const seg = this.segments[this.activeIndex];
      if (seg.meta) this.chunkStartCallback?.(seg.meta, seg.timings);
    }
    // M6: al cruzar frontera(s) se poda la metadata drenada y se evicta el
    // SourceBuffer proactivamente (throttle natural: ~1 vez por chunk).
    if (this.activeIndex > before) {
      this.pruneSegments();
      this.proactiveEvict();
    }

    // Fin real del stream: se alcanzó el fin del último segmento anexado y no
    // hay nada pendiente por anexar. Equivale al `ended` sin cola del motor
    // clásico → endCallback (PlayerBar decide siguiente chunk o avance).
    // A5: si hay un fetch EN VUELO (_expectingMore) que aún aportará chunks,
    // esto NO es fin: el último segmento anexado no es el último del párrafo.
    // El underrun esperará; al llegar el chunk vía queueNext el append reanuda.
    const last = this.segments[this.segments.length - 1];
    if (
      last &&
      this.pending.length === 0 &&
      !this._expectingMore &&
      this.activeIndex === this.segments.length - 1 &&
      posMs >= last.endMs - END_EPS_MS &&
      !this._endFired
    ) {
      this._endFired = true;
      this.markEnded();
      this.endCallback?.();
    }
  }

  /** Fin del stream detectado por estancamiento (`waiting`/`stalled`). */
  private endOnStall(): void {
    if (!this._hasCurrent || this._endFired) return;
    // A5: un fetch en vuelo hará crecer el stream → el estancamiento es underrun
    // de red, NO fin. Se espera (el elemento reanuda solo al anexar el chunk).
    if (this._expectingMore) return;
    // Solo es fin si estamos en el ÚLTIMO segmento anexado y no hay appends
    // pendientes: un waiting a media stream (no debería ocurrir en modo
    // sequence) no debe disparar avances en falso.
    if (this.pending.length > 0) return;
    if (this.segments.length === 0) return;
    if (this.activeIndex !== this.segments.length - 1) return;
    // A5 (blindaje de posición): un stall fuera del ÚLTIMO chunk no es fin.
    // OJO: aquí NO se usa END_EPS_MS (24ms) — verificado en QA que el elemento
    // puede estancarse ~100-150ms antes del endMs calculado (el residuo del
    // último frame MP3 no es decodificable), y con el margen fino el fin no
    // disparaba nunca → "reproduciendo" clavado al final del documento. Con
    // pending vacío y sin fetches esperados TODO el audio conocido ya está
    // anexado, así que un `waiting` dentro del último chunk significa "se
    // consumió todo lo decodificable" = fin. El margen es medio chunk (tope
    // 1500ms) solo como sanidad contra un waiting espurio recién arrancado.
    const last = this.segments[this.segments.length - 1];
    const posMs = this.audio ? this.audio.currentTime * 1000 : 0;
    const stallEps = Math.min(1500, (last.endMs - last.startMs) / 2);
    if (posMs < last.endMs - stallEps) return;
    this._endFired = true;
    this.markEnded();
    this.endCallback?.();
  }

  /**
   * A6: fin NATURAL del stream. Deja el motor en el mismo estado que el clásico
   * tras `ended`: sin stream vigente, de modo que getCurrentPositionMs() = 0 y
   * el próximo ▶ tome el camino de RECARGA en PlayerBar (en vez de un resume()
   * sobre un stream drenado → "reproduciendo" mudo sin salida). No hace teardown
   * completo del elemento (el próximo load() lo hará): solo neutraliza el stream
   * drenado. Si PlayerBar continúa (siguiente chunk/párrafo), su load() vuelve a
   * poner _hasCurrent=true; si es fin de documento, queda en false = recargar.
   */
  private markEnded(): void {
    this._hasCurrent = false;
    cancelAnimationFrame(this._rafId);
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
