import { WordTiming } from '../types';

// ── Callback types ────────────────────────────────────────────────────────

export type WordChangeCallback = (wordIndex: number) => void;
export type EndCallback = () => void;

// ── PlayerAgent (stub — real implementation in Task 11) ───────────────────

class PlayerAgent {
  private ctx: AudioContext | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
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

  load(paragraphId: string, audio: AudioBuffer, timings: WordTiming[]): void {
    this.fullStop();
    this._currentParagraphId = paragraphId;
    this._timings = timings;
    const ctx = this.getCtx();
    this.sourceNode = ctx.createBufferSource();
    this.sourceNode.buffer = audio;
    this.sourceNode.connect(ctx.destination);

    this.sourceNode.onended = () => {
      this._currentParagraphId = null;
      this._timings = [];
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
    this.getCtx().resume();
    this._startWordTracking();
  }

  fullStop(): void {
    cancelAnimationFrame(this._rafId);
    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch { /* already stopped */ }
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    this._currentParagraphId = null;
    this._timings = [];
  }

  getCurrentPositionMs(): number {
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
