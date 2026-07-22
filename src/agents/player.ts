import { WordTiming } from '../types';
import { MseEngine } from './mse-player';
import type {
  PlaybackEngine,
  WordChangeCallback,
  EndCallback,
  ErrorCallback,
  ChunkStartCallback,
  PlayBlockedCallback,
  QueuedChunkMeta,
} from './playback-engine';

// Re-export de los tipos del motor para no romper imports existentes.
export type {
  PlaybackEngine,
  WordChangeCallback,
  EndCallback,
  ErrorCallback,
  ChunkStartCallback,
  PlayBlockedCallback,
  QueuedChunkMeta,
} from './playback-engine';

// ── PlayerAgent sobre <audio> ─────────────────────────────────────────────
// Reproduce el MP3 crudo en un HTMLAudioElement en vez de decodificarlo con
// Web Audio API. Motivos:
// - BACKGROUND AUDIO: iOS suspende el AudioContext al bloquear la pantalla,
//   pero mantiene sonando un <audio>; con esto la app funciona como audiolibro
//   real en iPhone (con Media Session para los controles de pantalla bloqueada).
// - Memoria/CPU: se evita inflar cada MP3 (~35 KB) a PCM (~2-4 MB) y el paso
//   de decodificación por párrafo.
// El karaoke se sincroniza leyendo audio.currentTime en un rAF (resolución
// sobrada para resaltar palabras).

export class PlayerAgent implements PlaybackEngine {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private _volume: number = 1;
  private wordCallback: WordChangeCallback | null = null;
  private endCallback: EndCallback | null = null;
  private errorCallback: ErrorCallback | null = null;
  private chunkStartCallback: ChunkStartCallback | null = null;
  private playBlockedCallback: PlayBlockedCallback | null = null;
  private _currentParagraphId: string | null = null;
  private _timings: WordTiming[] = [];
  private _rafId: number = 0;
  // Chunk siguiente PRE-ENCOLADO (object URL ya creado): en `ended` se hace el
  // swap src+play() SÍNCRONO, sin fetch ni limpieza intermedia. Clave para
  // Android: un play() encadenado dentro del handler de `ended` sobre el mismo
  // <audio> ya desbloqueado sí se permite en background; el ciclo anterior
  // (fetch async → removeAttribute → load → play) se bloqueaba al minimizar.
  private queuedUrl: string | null = null;
  private queuedTimings: WordTiming[] = [];
  private queuedMeta: QueuedChunkMeta | null = null;

  private getAudio(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      // iOS: reproducir inline (sin fullscreen).
      this.audio.setAttribute('playsinline', 'true');
      this.audio.volume = this._volume;
    }
    return this.audio;
  }

  /** Carga un párrafo: partes MP3 crudas (stream MPEG concatenable) + timings. */
  // durationMs se ignora en el motor clásico (el <audio> conoce su propia
  // duración); se acepta solo para cumplir la interfaz PlaybackEngine.
  load(paragraphId: string, mp3Parts: ArrayBuffer[], timings: WordTiming[], _durationMs?: number): void {
    this.fullStop();
    this._currentParagraphId = paragraphId;
    this._timings = timings;

    const audio = this.getAudio();
    const blob = new Blob(mp3Parts, { type: 'audio/mpeg' });
    this.objectUrl = URL.createObjectURL(blob);
    audio.src = this.objectUrl;

    audio.onended = () => {
      cancelAnimationFrame(this._rafId);
      // Si hay un chunk pre-encolado, el swap es SÍNCRONO aquí dentro del
      // handler de `ended`: mismo elemento, sin limpieza ni fetch de por medio.
      if (this.queuedUrl && this.queuedMeta) {
        const meta = this.queuedMeta;
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = this.queuedUrl;
        this._timings = this.queuedTimings;
        this._currentParagraphId = meta.paragraphId;
        this.queuedUrl = null;
        this.queuedTimings = [];
        this.queuedMeta = null;
        audio.src = this.objectUrl;
        void audio.play().catch(() => this.playBlockedCallback?.());
        this._startWordTracking();
        this.chunkStartCallback?.(meta, this._timings);
        return;
      }
      // Fin natural sin cola: limpia estado para que getCurrentPositionMs()
      // regrese 0 (handlePlayPause no debe intentar resume de un audio
      // terminado) y delega el avance al endCallback.
      this._currentParagraphId = null;
      this._timings = [];
      this.endCallback?.();
    };

    // Un MP3 corrupto/truncado (upstream frágil) hace que el <audio> emita
    // `error` (code 4 / duration NaN) y NUNCA dispare `ended`: sin este handler
    // la reproducción se quedaba muerta en silencio, sin avanzar ni reintentar,
    // y el usuario veía ▶ sin sonido y sin error visible. Lo enrutamos a la
    // recuperación del PlayerBar (reintentar/saltar) igual que un chunk fallido.
    audio.onerror = () => {
      this._currentParagraphId = null;
      this._timings = [];
      cancelAnimationFrame(this._rafId);
      this.errorCallback?.();
    };
  }

  play(): void {
    const audio = this.audio;
    if (!audio || !this._currentParagraphId) return;
    // Un rechazo (autoplay/background) ya no es silencioso: se notifica para
    // que la UI quede en pausa honesta en vez de "reproduciendo" mudo.
    void audio.play().catch(() => this.playBlockedCallback?.());
    this._startWordTracking();
  }

  /** Pre-encola el SIGUIENTE chunk (object URL creado desde ya). Reemplaza
   *  cualquier encolado previo. Se consume en `ended`; fullStop lo limpia. */
  queueNext(mp3Parts: ArrayBuffer[], timings: WordTiming[], meta: QueuedChunkMeta, _durationMs?: number): void {
    this.clearQueued();
    const blob = new Blob(mp3Parts, { type: 'audio/mpeg' });
    this.queuedUrl = URL.createObjectURL(blob);
    this.queuedTimings = timings;
    this.queuedMeta = meta;
  }

  // A5: no-op en el motor clásico. Reasigna `src` por chunk (no hay stream
  // continuo ni "buffer drenado a la espera de más datos"), así que no necesita
  // saber de fetches en vuelo para distinguir un underrun del fin del párrafo.
  setExpectingMore(_expecting: boolean): void {
    /* no-op */
  }

  private clearQueued(): void {
    if (this.queuedUrl) {
      URL.revokeObjectURL(this.queuedUrl);
      this.queuedUrl = null;
    }
    this.queuedTimings = [];
    this.queuedMeta = null;
  }

  pause(): void {
    this.audio?.pause();
    cancelAnimationFrame(this._rafId);
  }

  resume(): void {
    // El handler `play` de Media Session (pantalla de bloqueo) llega aquí:
    // audio.play() reanuda incluso desde background en iOS.
    const audio = this.audio;
    if (!audio || !this._currentParagraphId) return;
    void audio.play().catch(() => { /* sin gesto válido; se reintenta al tocar ▶ */ });
    this._startWordTracking();
  }

  setVolume(volume: number): void {
    this._volume = Math.max(0, Math.min(1, volume));
    if (this.audio) this.audio.volume = this._volume;
  }

  getVolume(): number {
    return this._volume;
  }

  fullStop(): void {
    cancelAnimationFrame(this._rafId);
    if (this.audio) {
      // Desata onended/onerror ANTES de parar: un stop manual (next/prev/reload)
      // no debe disparar el end callback ni la recuperación de error (quitar el
      // src y llamar load() emite un `error` espurio que dispararía un salto).
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.clearQueued();
    this._currentParagraphId = null;
    this._timings = [];
  }

  getCurrentPositionMs(): number {
    // audio.currentTime se congela en pausa y se limpia tras onended/fullStop,
    // así que el contrato es idéntico al del motor Web Audio anterior.
    if (!this._currentParagraphId || !this.audio) return 0;
    return Math.max(0, this.audio.currentTime * 1000);
  }

  setWordChangeCallback(cb: WordChangeCallback): void {
    this.wordCallback = cb;
  }

  setChunkStartCallback(cb: ChunkStartCallback): void {
    this.chunkStartCallback = cb;
  }

  setPlayBlockedCallback(cb: PlayBlockedCallback): void {
    this.playBlockedCallback = cb;
  }

  setEndCallback(cb: EndCallback): void {
    this.endCallback = cb;
  }

  setErrorCallback(cb: ErrorCallback): void {
    this.errorCallback = cb;
  }

  destroy(): void {
    this.fullStop();
    // A2: anula los callbacks registrados. El motor es un SINGLETON compartido;
    // si un fetch TTS en vuelo de un PlayerBar ya desmontado resolviera y
    // llamara load(), sin esto los callbacks viejos (endCallback/chunkStart/
    // error) revivirían la cadena del libro cerrado. El PlayerBar que se monte
    // de nuevo re-registra los suyos en su useEffect (orden seguro en StrictMode:
    // cleanup→destroy→efecto vuelve a registrar).
    this.wordCallback = null;
    this.endCallback = null;
    this.errorCallback = null;
    this.chunkStartCallback = null;
    this.playBlockedCallback = null;
    this.audio = null;
  }

  private _startWordTracking(): void {
    cancelAnimationFrame(this._rafId);
    const tick = () => {
      const ms = this.getCurrentPositionMs();
      if (this._timings.length > 0) {
        const idx = this._timings.findIndex(
          (t) => ms >= t.offsetMs && ms < t.offsetMs + t.durationMs
        );
        if (idx >= 0) {
          this.wordCallback?.(idx);
        }
      }
      if (this._currentParagraphId) {
        this._rafId = requestAnimationFrame(tick);
      }
    };
    this._rafId = requestAnimationFrame(tick);
  }
}

// ── Selección de motor por CAPACIDAD (no por user-agent) ──────────────────
// Se usa el motor MSE (stream continuo, sobrevive a la pantalla apagada en
// Android) cuando el navegador soporta MediaSource real con 'audio/mpeg'. En
// iPhone el MediaSource clásico NO existe (solo ManagedMediaSource en WebKit):
// ahí se cae al motor clásico, que ya funciona en background en iOS.
// Escape hatch para soporte remoto (sin UI): localStorage folio-engine=classic
// fuerza el motor clásico en cualquier dispositivo.
function selectEngine(): PlaybackEngine {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('folio-engine') === 'classic') {
      return new PlayerAgent();
    }
  } catch {
    /* localStorage bloqueado (modo privado): sigue con detección por capacidad. */
  }

  const hasWindow = typeof window !== 'undefined';
  const hasRealMediaSource =
    hasWindow &&
    'MediaSource' in window &&
    typeof MediaSource !== 'undefined' &&
    typeof MediaSource.isTypeSupported === 'function' &&
    MediaSource.isTypeSupported('audio/mpeg');
  // WebKit-sin-MSE-real: si solo existe ManagedMediaSource (iOS) pero no el
  // MediaSource clásico, NO usamos el motor MSE.
  const onlyManaged =
    hasWindow && !('MediaSource' in window) && 'ManagedMediaSource' in window;

  if (hasRealMediaSource && !onlyManaged) {
    return new MseEngine();
  }
  return new PlayerAgent();
}

export const playerAgent: PlaybackEngine = selectEngine();
