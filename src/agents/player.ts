import { WordTiming } from '../types';

// ── Callback types ────────────────────────────────────────────────────────

export type WordChangeCallback = (wordIndex: number) => void;
export type EndCallback = () => void;

// ── PlayerAgent (stub — real implementation in Task 11) ───────────────────

class PlayerAgent {
  private ctx: AudioContext | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private _volume: number = 1;
  private wordCallback: WordChangeCallback | null = null;
  private endCallback: EndCallback | null = null;
  private _currentParagraphId: string | null = null;
  private _timings: WordTiming[] = [];
  private _startTime: number = 0;
  private _rafId: number = 0;

  private getCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  // Nodo de ganancia persistente (source → gain → destination). Se crea una
  // sola vez por AudioContext y sobrevive a cada load(), preservando el volumen
  // configurado por el usuario entre párrafos.
  private getGain(): GainNode {
    const ctx = this.getCtx();
    if (!this.gainNode) {
      this.gainNode = ctx.createGain();
      this.gainNode.gain.value = this._volume;
      this.gainNode.connect(ctx.destination);
    }
    return this.gainNode;
  }

  load(paragraphId: string, audio: AudioBuffer, timings: WordTiming[]): void {
    this.fullStop();
    this._currentParagraphId = paragraphId;
    this._timings = timings;
    const ctx = this.getCtx();
    this.sourceNode = ctx.createBufferSource();
    this.sourceNode.buffer = audio;
    // source → gain → destination para que setVolume() afecte la reproducción.
    this.sourceNode.connect(this.getGain());

    const node = this.sourceNode;
    node.onended = () => {
      // Natural end of playback: clear all state so getCurrentPositionMs()
      // returns 0 (handlePlayPause must NOT try to resume a finished source).
      this._currentParagraphId = null;
      this._timings = [];
      if (this.sourceNode === node) {
        node.disconnect();
        this.sourceNode = null;
      }
      cancelAnimationFrame(this._rafId);
      this.endCallback?.();
    };
  }

  play(): void {
    if (!this.sourceNode) return;
    this._startTime = this.getCtx().currentTime;
    this.sourceNode.start(0);
    this._startWordTracking();
  }

  pause(): void {
    this.getCtx().suspend();
    cancelAnimationFrame(this._rafId);
  }

  resume(): void {
    // BACKGROUND AUDIO: en móvil, al bloquear la pantalla el navegador suspende
    // el AudioContext (y con él congela currentTime). No hay forma de mantener
    // el audio corriendo con la pantalla bloqueada sin un backend distinto
    // (p. ej. un <audio>/MediaSource con audio pre-renderizado); el AudioContext
    // de la Web Audio API se suspende por política del SO. La mitigación es que
    // el handler `play` de Media Session (control de la pantalla de bloqueo)
    // llame a resume(), que reanuda el contexto y retoma el tracking de palabras.
    this.getCtx().resume();
    this._startWordTracking();
  }

  setVolume(volume: number): void {
    this._volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode) {
      this.gainNode.gain.value = this._volume;
    }
  }

  getVolume(): number {
    return this._volume;
  }

  fullStop(): void {
    cancelAnimationFrame(this._rafId);
    if (this.sourceNode) {
      // Detach onended BEFORE stopping: a manual stop (next/prev/reload) must
      // not fire the end callback, which would auto-advance spuriously.
      this.sourceNode.onended = null;
      try { this.sourceNode.stop(); } catch { /* already stopped */ }
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    this._currentParagraphId = null;
    this._timings = [];
  }

  getCurrentPositionMs(): number {
    // While the AudioContext is suspended (pause), ctx.currentTime freezes,
    // so `currentTime - _startTime` stays put and resume() continues tracking
    // correctly without re-anchoring _startTime. After onended, both fields
    // below are cleared, so this returns 0 for a finished source.
    if (!this._currentParagraphId || !this.sourceNode) return 0;
    const elapsed = (this.getCtx().currentTime - this._startTime) * 1000;
    return Math.max(0, elapsed);
  }

  setWordChangeCallback(cb: WordChangeCallback): void {
    this.wordCallback = cb;
  }

  setEndCallback(cb: EndCallback): void {
    this.endCallback = cb;
  }

  destroy(): void {
    this.fullStop();
    if (this.gainNode) {
      try { this.gainNode.disconnect(); } catch { /* already disconnected */ }
      this.gainNode = null;
    }
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
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
