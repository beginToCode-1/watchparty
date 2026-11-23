import type { MediaAdapter, MediaAdapterEvent } from '../controller.js';

/**
 * MediaAdapter over an HTMLMediaElement (web Mode A file/HLS/local, extension Mode B). Touches no DOM globals,
 * only the element it is given. `play()` returns the element's promise; a NotAllowedError (autoplay policy)
 * rejects it and SyncController surfaces it through `onAutoplayBlocked`.
 */
export class HTMLVideoAdapter implements MediaAdapter {
  readonly supportsFineRate = true;
  private readonly offs = new Set<() => void>();

  constructor(readonly element: HTMLMediaElement) {}

  getPosition(): number {
    return this.element.currentTime;
  }

  getDuration(): number | null {
    const d = this.element.duration;
    return Number.isFinite(d) && d > 0 ? d : null;
  }

  getRate(): number {
    return this.element.playbackRate;
  }

  isPaused(): boolean {
    return this.element.paused;
  }

  isSeeking(): boolean {
    return this.element.seeking;
  }

  isEnded(): boolean {
    return this.element.ended;
  }

  readyState(): number {
    return this.element.readyState;
  }

  play(): Promise<void> {
    return this.element.play();
  }

  pause(): void {
    this.element.pause();
  }

  seek(seconds: number): void {
    const d = this.getDuration();
    this.element.currentTime = Math.max(0, d === null ? seconds : Math.min(seconds, d));
  }

  setRate(rate: number): void {
    this.element.playbackRate = rate;
  }

  on(event: MediaAdapterEvent, cb: () => void): () => void {
    const handler = (): void => cb();
    this.element.addEventListener(event, handler);
    const off = (): void => {
      this.element.removeEventListener(event, handler);
      this.offs.delete(off);
    };
    this.offs.add(off);
    return off;
  }

  destroy(): void {
    for (const off of [...this.offs]) off();
  }
}
