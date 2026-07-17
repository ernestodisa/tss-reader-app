import { WordTiming } from '../types';

// ── Callback types ────────────────────────────────────────────────────────

export type WordChangeCallback = (wordIndex: number) => void;
export type EndCallback = () => void;
export type ErrorCallback = () => void;

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

class PlayerAgent {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private _volume: number = 1;
  private wordCallback: WordChangeCallback | null = null;
  private endCallback: EndCallback | null = null;
  private errorCallback: ErrorCallback | null = null;
  private _currentParagraphId: string | null = null;
  private _timings: WordTiming[] = [];
  private _rafId: number = 0;

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
  load(paragraphId: string, mp3Parts: ArrayBuffer[], timings: WordTiming[]): void {
    this.fullStop();
    this._currentParagraphId = paragraphId;
    this._timings = timings;

    const audio = this.getAudio();
    const blob = new Blob(mp3Parts, { type: 'audio/mpeg' });
    this.objectUrl = URL.createObjectURL(blob);
    audio.src = this.objectUrl;

    audio.onended = () => {
      // Fin natural: limpia estado para que getCurrentPositionMs() regrese 0
      // (handlePlayPause no debe intentar resume de un audio terminado).
      this._currentParagraphId = null;
      this._timings = [];
      cancelAnimationFrame(this._rafId);
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
    void audio.play().catch(() => { /* autoplay bloqueado: el próximo gesto reintenta */ });
    this._startWordTracking();
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

  setEndCallback(cb: EndCallback): void {
    this.endCallback = cb;
  }

  setErrorCallback(cb: ErrorCallback): void {
    this.errorCallback = cb;
  }

  destroy(): void {
    this.fullStop();
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

export const playerAgent = new PlayerAgent();
