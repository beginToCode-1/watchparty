import type { MediaAdapter, MediaAdapterEvent } from '@watchparty/sync-engine';

// MediaAdapter over the YouTube IFrame Player API (docs/WEBRTC_AND_MEDIA.md §1.7).
// YouTube has no fine playbackRate (0.25 steps), so drift is corrected by hard seeks only.

let apiPromise: Promise<void> | null = null;

/** Injects https://www.youtube.com/iframe_api once; resolves when `YT.Player` is usable. */
export function loadYouTubeApi(): Promise<void> {
  if (typeof YT !== 'undefined' && typeof YT.Player === 'function') return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      script.remove();
      reject(new Error('Could not load the YouTube player (blocked or offline).'));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

const POLL_MS = 250;
const SEEK_JUMP_S = 1;
const SEEK_SETTLE_S = 1;
const SEEK_TIMEOUT_MS = 2_000;
const PLAY_TIMEOUT_MS = 3_000;

/** Same name as the DOMException a blocked HTMLMediaElement.play() rejects with; the controller keys off it. */
function blockedError(): Error {
  const e = new Error('Autoplay was blocked');
  e.name = 'NotAllowedError';
  return e;
}

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
  }
}

export class YouTubeAdapter implements MediaAdapter {
  readonly supportsFineRate = false;
  private readonly events = new EventTarget();
  private readonly alive = new AbortController();
  private ready = false;
  private ytState: number = -1;
  private logicalPaused = true;
  private ended = false;
  private seekTarget: number | null = null;
  private seekStartedAt = 0;
  private lastTime = 0;
  private lastPollAt = 0;
  private poll: ReturnType<typeof setInterval> | null = null;
  private pendingPlay: { resolve: () => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> } | null =
    null;

  constructor(private readonly player: YT.Player) {}

  /** Wire from the YT.Player `events` options. */
  handleReady(): void {
    this.ready = true;
    this.lastTime = this.safeTime();
    this.lastPollAt = performance.now();
    this.poll = setInterval(() => this.onPoll(), POLL_MS);
    this.emit('durationchange');
    this.emit('canplaythrough');
  }

  handleStateChange(state: number): void {
    const prev = this.ytState;
    this.ytState = state;
    switch (state) {
      case YT.PlayerState.PLAYING:
        this.ended = false;
        this.markPlaying();
        this.settlePendingPlay(true);
        this.finishSeekIfSettled();
        this.emit('playing');
        this.emit('canplaythrough');
        break;
      case YT.PlayerState.BUFFERING:
        // Our own playVideo() goes through BUFFERING first: count it as "play". A scrub in YouTube's UI while paused
        // also buffers and must not unpause the room; a user-initiated play is still caught at PLAYING.
        // play() itself only resolves at PLAYING: an autoplay block also buffers first, then drops to UNSTARTED.
        if (this.pendingPlay !== null && prev !== YT.PlayerState.PLAYING) this.markPlaying();
        this.emit('waiting');
        break;
      case YT.PlayerState.UNSTARTED:
        if (this.pendingPlay !== null) {
          // Our playVideo() went BUFFERING -> UNSTARTED: the browser blocked autoplay. That is a failed play, not a
          // user pause, so nothing is emitted (the room must not pause); the rejection shows "click to join".
          if (prev === YT.PlayerState.BUFFERING) {
            this.logicalPaused = true;
            this.settlePendingPlay(false, blockedError());
          }
          break; // otherwise: the normal UNSTARTED that precedes BUFFERING on every start
        }
        // pauseVideo() during the very first buffer drops back to UNSTARTED, not PAUSED; without this the
        // adapter still reports "playing" and the room's resume never calls playVideo() again.
        this.onPaused();
        break;
      case YT.PlayerState.PAUSED:
        this.onPaused();
        break;
      case YT.PlayerState.ENDED:
        this.ended = true;
        if (!this.logicalPaused) {
          this.logicalPaused = true;
          this.emit('pause');
        }
        this.emit('ended');
        break;
      case YT.PlayerState.CUED:
        this.emit('durationchange');
        this.emit('canplaythrough');
        break;
      default:
        break;
    }
  }

  private onPaused(): void {
    this.finishSeekIfSettled();
    if (!this.logicalPaused) {
      this.logicalPaused = true;
      this.emit('pause');
    }
    this.emit('canplaythrough');
  }

  handleRateChange(): void {
    this.emit('ratechange');
  }

  handleError(): void {
    this.settlePendingPlay(false, new Error('YouTube player error'));
    this.emit('error');
  }

  getPosition(): number {
    return this.seekTarget ?? this.safeTime();
  }

  getDuration(): number | null {
    if (!this.ready) return null;
    const d = this.player.getDuration();
    return Number.isFinite(d) && d > 0 ? d : null;
  }

  getRate(): number {
    return this.ready ? this.player.getPlaybackRate() : 1;
  }

  isPaused(): boolean {
    return this.logicalPaused;
  }

  isSeeking(): boolean {
    return this.seekTarget !== null;
  }

  isEnded(): boolean {
    return this.ended;
  }

  readyState(): number {
    if (!this.ready) return 0;
    return this.ytState === YT.PlayerState.BUFFERING ? 2 : 4;
  }

  play(): Promise<void> {
    if (!this.ready) return Promise.reject(new Error('YouTube player not ready'));
    this.settlePendingPlay(false, new Error('superseded'));
    return new Promise<void>((resolve, reject) => {
      // The IFrame API has no play() promise; an autoplay block can also show up as "never started playing".
      // Still buffering (slow network) is not a block: keep waiting.
      const onTimeout = (): void => {
        const p = this.pendingPlay;
        if (p?.resolve !== resolve) return;
        if (this.ytState === YT.PlayerState.BUFFERING) {
          p.timer = setTimeout(onTimeout, PLAY_TIMEOUT_MS);
          return;
        }
        this.pendingPlay = null;
        reject(blockedError());
      };
      this.pendingPlay = { resolve, reject, timer: setTimeout(onTimeout, PLAY_TIMEOUT_MS) };
      this.player.playVideo();
    });
  }

  pause(): void {
    if (!this.ready) return;
    // Like HTMLMediaElement: pausing aborts a play that hasn't started yet (not an autoplay block).
    const aborted = new Error('play() was interrupted by pause()');
    aborted.name = 'AbortError';
    this.settlePendingPlay(false, aborted);
    this.player.pauseVideo();
  }

  seek(seconds: number): void {
    if (!this.ready) return;
    const d = this.getDuration();
    const target = Math.max(0, d === null ? seconds : Math.min(seconds, d));
    this.seekTarget = target;
    this.seekStartedAt = performance.now();
    this.player.seekTo(target, true);
  }

  setRate(rate: number): void {
    if (!this.ready) return;
    const rates = this.player.getAvailablePlaybackRates();
    const best = rates.reduce((a, b) => (Math.abs(b - rate) < Math.abs(a - rate) ? b : a), 1);
    if (best !== this.player.getPlaybackRate()) this.player.setPlaybackRate(best);
  }

  on(event: MediaAdapterEvent, cb: () => void): () => void {
    this.events.addEventListener(event, cb, { signal: this.alive.signal });
    return () => this.events.removeEventListener(event, cb);
  }

  destroy(): void {
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
    this.settlePendingPlay(false, new Error('destroyed'));
    this.alive.abort();
  }

  private safeTime(): number {
    if (!this.ready) return 0;
    const t = this.player.getCurrentTime();
    return Number.isFinite(t) ? t : 0;
  }

  private markPlaying(): void {
    if (!this.logicalPaused) return;
    this.logicalPaused = false;
    this.emit('play');
  }

  private settlePendingPlay(ok: boolean, err?: unknown): void {
    const p = this.pendingPlay;
    if (!p) return;
    this.pendingPlay = null;
    clearTimeout(p.timer);
    if (ok) p.resolve();
    else p.reject(err);
  }

  private finishSeekIfSettled(): void {
    if (this.seekTarget === null) return;
    const t = this.safeTime();
    if (Math.abs(t - this.seekTarget) <= SEEK_SETTLE_S || performance.now() - this.seekStartedAt > SEEK_TIMEOUT_MS) {
      this.seekTarget = null;
      this.lastTime = t;
      this.lastPollAt = performance.now();
      this.emit('seeked');
    }
  }

  /** Seek detection for scrubs in YouTube's own UI: the time jumped more than playback explains. */
  private onPoll(): void {
    const now = performance.now();
    const t = this.safeTime();
    if (this.seekTarget !== null) {
      if (this.ytState !== YT.PlayerState.BUFFERING) this.finishSeekIfSettled();
    } else {
      const playing = this.ytState === YT.PlayerState.PLAYING;
      const expected = this.lastTime + (playing ? ((now - this.lastPollAt) / 1000) * this.getRate() : 0);
      if (Math.abs(t - expected) > SEEK_JUMP_S) this.emit('seeked');
    }
    this.lastTime = t;
    this.lastPollAt = now;
  }

  private emit(event: MediaAdapterEvent): void {
    this.events.dispatchEvent(new Event(event));
  }
}
