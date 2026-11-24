import {
  BUFFER_GRACE_MS,
  CLOCK_READY_TIMEOUT_MS,
  CORRECTION_INTERVAL_MS,
  CORRECTION_RATE_MAX,
  CORRECTION_RATE_MIN,
  DRIFT_GAIN,
  DRIFT_HARD_SEEK_COARSE_S,
  DRIFT_HARD_SEEK_S,
  DRIFT_IGNORE_S,
  INTENT_DEBOUNCE_MS,
  MAX_POSITION_S,
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  REMOTE_LOCK_TIMEOUT_MS,
  SEEK_DEBOUNCE_MS,
  STARTUP_GRACE_MS,
  type Ack,
  type ErrorCode,
  type PlaybackState,
  type PlayerAck,
  type RoomBufferEvent,
  type RoomStateEvent,
} from '@watchparty/shared-types';
import type { ClockSync, SyncTransport } from './clock.js';

const ADAPTER_EVENTS = [
  'play',
  'pause',
  'seeked',
  'ratechange',
  'waiting',
  'stalled',
  'playing',
  'canplaythrough',
  'ended',
  'error',
  'durationchange',
] as const;
export type MediaAdapterEvent = (typeof ADAPTER_EVENTS)[number];

/** docs/SYNC_PROTOCOL.md §5.1. */
export interface MediaAdapter {
  readonly supportsFineRate: boolean;
  getPosition(): number;
  getDuration(): number | null;
  getRate(): number;
  isPaused(): boolean;
  isSeeking(): boolean;
  isEnded(): boolean;
  readyState(): number;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setRate(rate: number): void;
  on(event: MediaAdapterEvent, cb: () => void): () => void;
  destroy(): void;
}

// SYNC_PROTOCOL §5.4: intents are acked within 3 s; until then the drift loop leaves the element alone.
const INTENT_ACK_TIMEOUT_MS = 3_000;
const RATE_EPSILON = 0.001;
const SEEK_LOCK_MAX_MS = 5_000;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const hardSeekS = (fineRate: boolean): number => (fineRate ? DRIFT_HARD_SEEK_S : DRIFT_HARD_SEEK_COARSE_S);
// Duck-typed: a DOMException from another realm (extension isolated world, iframe) fails `instanceof Error`.
const isAutoplayBlock = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'NotAllowedError';

/** Expected media position at server time `serverNow` (§4.2); frozen until a scheduled `updatedAt`. */
export function expectedPosition(state: PlaybackState, serverNow: number, duration?: number | null): number {
  const pos = state.paused
    ? state.position
    : state.position + (Math.max(0, serverNow - state.updatedAt) / 1000) * state.rate;
  return duration != null && duration > 0 ? clamp(pos, 0, duration) : Math.max(0, pos);
}

export type Correction = { type: 'none' } | { type: 'rate'; rate: number } | { type: 'seek'; position: number };

/**
 * Drift band policy (§6.1). `drift` = local − expected seconds (positive = ahead). A seek also means
 * "reset rate to base"; the caller does that.
 */
export function computeCorrection(
  drift: number,
  baseRate: number,
  rttMs: number,
  expected: number,
  fineRate = true,
): Correction {
  const a = Math.abs(drift);
  if (a < DRIFT_IGNORE_S) return { type: 'rate', rate: baseRate };
  if (a <= hardSeekS(fineRate)) {
    if (!fineRate) return { type: 'none' };
    return { type: 'rate', rate: baseRate * clamp(1 - drift * DRIFT_GAIN, CORRECTION_RATE_MIN, CORRECTION_RATE_MAX) };
  }
  return { type: 'seek', position: expected + (rttMs / 2000) * baseRate };
}

export interface SyncStatus {
  drift: number | null;
  rate: number;
  offset: number;
  rtt: number;
  waiting: boolean;
  buffering: boolean;
}

export interface SyncControllerOptions {
  transport: SyncTransport;
  clock: ClockSync;
  adapter?: MediaAdapter;
  /** `mediaUrl` changed: the controller has detached; build the new adapter and call `attach`. */
  onMediaChange?: (state: PlaybackState) => void;
  /** `play()` was rejected (autoplay policy). Show a click-to-join overlay that calls `resumeAfterGesture()`. */
  onAutoplayBlocked?: (err: unknown) => void;
  /** The server refused a local intent; local playback was already snapped back to the room state. */
  onIntentRejected?: (error: { code: ErrorCode; message: string }) => void;
  /** Called every correction tick for the sync-status indicator. */
  onStatus?: (status: SyncStatus) => void;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Drives one MediaAdapter from the room's authoritative PlaybackState (docs/SYNC_PROTOCOL.md §5–§8):
 * applies `room:state` under the isRemoteAction lock, runs the drift loop, turns local media events into
 * debounced `player:*` intents and reports wait-for-buffer. Listens to `room:state`, `room:buffer` and
 * `connect` on the transport itself; feed it the `room:join`/`room:create` ack state with `applyState`.
 */
export class SyncController {
  private readonly transport: SyncTransport;
  private readonly clock: ClockSync;
  private adapter: MediaAdapter | null = null;
  private adapterOffs: (() => void)[] = [];
  private current: PlaybackState | null = null;
  private lastSeq: number | null = null;
  private appliedRate = 1;
  private attachedAt = 0;
  private needsAttachApply = false;
  private pendingApply: { jump: boolean } | null = null;
  private roomWaiting = false;

  private lock: { expected: Set<MediaAdapterEvent>; timer: Timer | null; since: number } | null = null;
  private pendingPlayPause: 'play' | 'pause' | null = null;
  private playPauseTimer: Timer | null = null;
  private seekTimer: Timer | null = null;
  private rateTimer: Timer | null = null;
  private intentGuardUntil = 0;
  private scheduleTimer: Timer | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private bufferPhase: 'idle' | 'grace' | 'reported' = 'idle';
  private graceTimer: Timer | null = null;
  private playStartAt = -Infinity;
  private lastDriftSeekAt = -Infinity;

  private readonly offClock: () => void;
  private readonly onRoomState = (p: RoomStateEvent): void => this.applyState(p.state);
  private readonly onRoomBuffer = (p: RoomBufferEvent): void => {
    this.roomWaiting = p.waiting;
  };
  private readonly onConnect = (): void => {
    this.lastSeq = null;
    this.roomWaiting = false;
    // The server dropped our buffering report with the old socket: start over and re-report if still stalled.
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.bufferPhase = 'idle';
    if (this.adapter && this.adapter.readyState() < 3) this.onStall();
  };
  private readonly ops = {
    play: () => {
      const a = this.adapter;
      if (!a) return;
      this.expect('play');
      this.playStartAt = Date.now();
      a.play().catch((err: unknown) => {
        if (this.lock?.expected.delete('play') && this.lock.expected.size === 0) this.releaseLock();
        // AbortError (pause() raced the play) and adapter teardown rejections are not autoplay blocks.
        if (isAutoplayBlock(err)) this.opts.onAutoplayBlocked?.(err);
      });
    },
    pause: () => {
      this.expect('pause');
      this.adapter?.pause();
    },
    seek: (seconds: number) => {
      this.expect('seeked');
      this.adapter?.seek(seconds);
    },
    setRate: (rate: number) => {
      this.expect('ratechange');
      this.appliedRate = rate;
      this.adapter?.setRate(rate);
    },
  };

  constructor(private readonly opts: SyncControllerOptions) {
    this.transport = opts.transport;
    this.clock = opts.clock;
    this.transport.on('room:state', this.onRoomState);
    this.transport.on('room:buffer', this.onRoomBuffer);
    this.transport.on('connect', this.onConnect);
    this.offClock = this.clock.onUpdate(() => this.retryPendingApply());
    if (opts.adapter) this.attach(opts.adapter);
  }

  get state(): PlaybackState | null {
    return this.current;
  }

  isRemoteAction(): boolean {
    return this.lock !== null;
  }

  attach(adapter: MediaAdapter): void {
    this.detach();
    this.adapter = adapter;
    this.attachedAt = Date.now();
    this.appliedRate = adapter.getRate();
    this.adapterOffs = ADAPTER_EVENTS.map((e) => adapter.on(e, () => this.onAdapterEvent(e)));
    this.needsAttachApply = true;
    this.tryAttachApply();
    this.tickTimer = setInterval(() => this.tick(), CORRECTION_INTERVAL_MS);
  }

  /** Stops driving the adapter (does not destroy it: its owner does). Drops pending intents, clears buffering. */
  detach(): void {
    if (this.bufferPhase === 'reported') this.transport.emit('player:buffering', { buffering: false });
    this.bufferPhase = 'idle';
    for (const t of [this.playPauseTimer, this.seekTimer, this.rateTimer, this.scheduleTimer, this.graceTimer]) {
      if (t !== null) clearTimeout(t);
    }
    this.playPauseTimer = this.seekTimer = this.rateTimer = this.scheduleTimer = this.graceTimer = null;
    this.pendingPlayPause = null;
    this.pendingApply = null;
    this.needsAttachApply = false;
    this.intentGuardUntil = 0;
    if (this.lock?.timer) clearTimeout(this.lock.timer);
    this.lock = null;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const off of this.adapterOffs) off();
    this.adapterOffs = [];
    this.adapter = null;
  }

  destroy(): void {
    this.detach();
    this.transport.off('room:state', this.onRoomState);
    this.transport.off('room:buffer', this.onRoomBuffer);
    this.transport.off('connect', this.onConnect);
    this.offClock();
  }

  /** Apply an authoritative state (from `room:state` or a create/join ack). Stale `seq` is dropped. */
  applyState(s: PlaybackState): void {
    if (this.lastSeq !== null && s.seq <= this.lastSeq) return;
    const prev = this.current;
    this.current = s;
    this.lastSeq = s.seq;
    this.pendingApply = null;
    if (this.scheduleTimer !== null) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    if (prev && s.mediaUrl !== prev.mediaUrl) {
      this.detach();
      this.opts.onMediaChange?.(s);
      return;
    }
    if (s.mode === 'C') return;
    // Play-after-pause is not a jump (§5.2): the sender's position ran on for INTENT_DEBOUNCE_MS before the flush.
    const debounceS = prev?.paused && !s.paused ? (INTENT_DEBOUNCE_MS / 1000) * s.rate : 0;
    const jump = prev === null || Math.abs(expectedPosition(prev, s.updatedAt) - s.position) > DRIFT_IGNORE_S + debounceS;
    this.apply(s, jump);
  }

  /** Call from a user gesture after `onAutoplayBlocked`. */
  resumeAfterGesture(): void {
    if (this.current && this.current.mode !== 'C') this.apply(this.current, false);
  }

  private clockUsable(): boolean {
    return (
      this.clock.ready && (this.clock.burstComplete || Date.now() - this.attachedAt >= CLOCK_READY_TIMEOUT_MS)
    );
  }

  private apply(s: PlaybackState, jump: boolean): void {
    const a = this.adapter;
    if (!a) return;
    if (a.readyState() < 1) {
      this.needsAttachApply = true;
      return;
    }
    if (!s.paused && !this.clockUsable()) {
      this.pendingApply = { jump: jump || (this.pendingApply?.jump ?? false) };
      return;
    }
    this.withRemoteLock((r) => {
      if (Math.abs(a.getRate() - s.rate) > RATE_EPSILON) r.setRate(s.rate);
      const local = a.getPosition();
      if (s.paused) {
        if (!a.isPaused()) r.pause();
        if (Math.abs(local - s.position) > DRIFT_IGNORE_S) r.seek(s.position);
        return;
      }
      const waitMs = s.updatedAt - this.clock.serverNow();
      if (waitMs > 0) {
        if (!a.isPaused()) r.pause();
        if (Math.abs(local - s.position) > DRIFT_IGNORE_S) r.seek(s.position);
        this.scheduleTimer = setTimeout(() => {
          this.scheduleTimer = null;
          if (this.current === s) this.apply(s, false);
        }, waitMs);
        return;
      }
      const target = expectedPosition(s, this.clock.serverNow(), a.getDuration());
      const threshold = jump ? DRIFT_IGNORE_S : hardSeekS(a.supportsFineRate);
      if (Math.abs(local - target) > threshold) r.seek(target + (this.clock.rtt / 2000) * s.rate);
      // Never play() at the end: an ended element restarts from 0.
      const duration = a.getDuration();
      if (a.isPaused() && (duration === null || target < duration - DRIFT_IGNORE_S)) r.play();
    });
  }

  private tryAttachApply(): void {
    const a = this.adapter;
    if (!this.needsAttachApply || !a || a.readyState() < 1) return;
    this.needsAttachApply = false;
    if (this.current && this.current.mode !== 'C') this.apply(this.current, true);
  }

  private retryPendingApply(): void {
    if (!this.pendingApply || !this.current || !this.clockUsable()) return;
    const { jump } = this.pendingApply;
    this.pendingApply = null;
    this.apply(this.current, jump);
  }

  // ---------- isRemoteAction lock (§5.3) ----------

  private withRemoteLock(fn: (r: SyncController['ops']) => void): void {
    if (!this.lock) this.lock = { expected: new Set(), timer: null, since: Date.now() };
    fn(this.ops);
    const lock = this.lock;
    if (!lock) return;
    if (lock.timer) clearTimeout(lock.timer);
    lock.timer = null;
    if (lock.expected.size === 0) this.releaseLock();
    else {
      lock.since = Date.now();
      lock.timer = setTimeout(this.onLockTimeout, REMOTE_LOCK_TIMEOUT_MS);
    }
  }

  /** Slow seeks (YouTube poll, HLS, unbuffered MP4) outlive 300 ms: hold the lock while still seeking, capped. */
  private readonly onLockTimeout = (): void => {
    const lock = this.lock;
    if (!lock) return;
    lock.timer = null;
    if (lock.expected.has('seeked') && this.adapter?.isSeeking() && Date.now() - lock.since < SEEK_LOCK_MAX_MS) {
      lock.timer = setTimeout(this.onLockTimeout, REMOTE_LOCK_TIMEOUT_MS);
      return;
    }
    this.releaseLock();
  };

  private expect(e: MediaAdapterEvent): void {
    this.lock?.expected.add(e);
  }

  private releaseLock(): void {
    if (this.lock?.timer) clearTimeout(this.lock.timer);
    this.lock = null;
  }

  // ---------- adapter events ----------

  private onAdapterEvent(e: MediaAdapterEvent): void {
    switch (e) {
      case 'play':
      case 'pause':
      case 'seeked':
      case 'ratechange':
        if (this.lock) {
          if (this.lock.expected.delete(e)) {
            if (this.lock.expected.size === 0) this.releaseLock();
            return;
          }
          // Unexpected seeked/ratechange are side effects of the remote action; a play/pause is the user (§5.3).
          if (e === 'seeked' || e === 'ratechange') return;
        }
        this.onIntentEvent(e);
        return;
      case 'waiting':
      case 'stalled':
        this.onStall();
        return;
      case 'playing':
      case 'canplaythrough':
        this.onBufferReady();
        this.tryAttachApply();
        return;
      case 'error':
        this.onBufferReady();
        return;
      case 'durationchange':
        this.tryAttachApply();
        return;
      case 'ended':
        return;
    }
  }

  // ---------- local intents (§5.4) ----------

  private onIntentEvent(e: 'play' | 'pause' | 'seeked' | 'ratechange'): void {
    const a = this.adapter;
    if (!a || !this.current || this.current.mode === 'C') return;
    if (e === 'play' || e === 'pause') {
      if (e === 'pause' && a.isEnded()) return;
      if (e === 'play') this.playStartAt = Date.now();
      this.pendingPlayPause = e;
      if (this.playPauseTimer !== null) clearTimeout(this.playPauseTimer);
      this.playPauseTimer = setTimeout(() => this.flushPlayPause(), INTENT_DEBOUNCE_MS);
    } else if (e === 'seeked') {
      if (this.seekTimer !== null) clearTimeout(this.seekTimer);
      this.seekTimer = setTimeout(() => this.flushSeek(), SEEK_DEBOUNCE_MS);
    } else {
      const rate = a.getRate();
      if (Math.abs(rate - this.appliedRate) <= RATE_EPSILON) return; // echo of a drift-loop nudge
      this.appliedRate = rate;
      if (this.rateTimer !== null) clearTimeout(this.rateTimer);
      this.rateTimer = setTimeout(() => this.flushRate(), INTENT_DEBOUNCE_MS);
    }
  }

  private localPosition(a: MediaAdapter): number {
    return clamp(a.getPosition(), 0, MAX_POSITION_S);
  }

  private flushPlayPause(): void {
    this.playPauseTimer = null;
    const kind = this.pendingPlayPause;
    this.pendingPlayPause = null;
    if (this.seekTimer !== null) clearTimeout(this.seekTimer); // play/pause carries the position
    this.seekTimer = null;
    const a = this.adapter;
    const cur = this.current;
    if (!kind || !a || !cur) return;
    const position = this.localPosition(a);
    if (kind === 'play') {
      const drift = position - expectedPosition(cur, this.clock.serverNow(), a.getDuration());
      if (!cur.paused && Math.abs(drift) < DRIFT_IGNORE_S) return;
      this.guardIntent();
      this.transport.emit('player:play', { position }, this.onIntentAck);
    } else {
      if (cur.paused && Math.abs(position - cur.position) < DRIFT_IGNORE_S) return;
      this.guardIntent();
      this.transport.emit('player:pause', { position }, this.onIntentAck);
    }
  }

  private flushSeek(): void {
    this.seekTimer = null;
    const a = this.adapter;
    const cur = this.current;
    if (!a || !cur) return;
    // A late `seeked` from a remote/drift seek lands near the room position: not a user intent (no echo loop).
    const drift = this.localPosition(a) - expectedPosition(cur, this.clock.serverNow(), a.getDuration());
    if (Math.abs(drift) <= (cur.paused ? DRIFT_IGNORE_S : hardSeekS(a.supportsFineRate))) return;
    this.guardIntent();
    this.transport.emit('player:seek', { position: this.localPosition(a) }, this.onIntentAck);
  }

  private flushRate(): void {
    this.rateTimer = null;
    const a = this.adapter;
    if (!a || !this.current) return;
    this.guardIntent();
    this.transport.emit('player:rate', { rate: clamp(a.getRate(), PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX) }, this.onIntentAck);
  }

  private guardIntent(): void {
    this.intentGuardUntil = Date.now() + INTENT_ACK_TIMEOUT_MS;
  }

  private readonly onIntentAck = (res: Ack<PlayerAck>): void => {
    this.intentGuardUntil = 0;
    if (res.ok) return;
    if (this.current && this.current.mode !== 'C') this.apply(this.current, true);
    this.opts.onIntentRejected?.(res.error);
  };

  private hasPendingIntent(): boolean {
    return (
      this.playPauseTimer !== null ||
      this.seekTimer !== null ||
      this.rateTimer !== null ||
      Date.now() < this.intentGuardUntil
    );
  }

  // ---------- wait-for-buffer reporting (§8.1) ----------

  private onStall(): void {
    if (this.bufferPhase !== 'idle' || !this.current || this.current.mode === 'C') return;
    this.bufferPhase = 'grace';
    const grace = Date.now() - this.playStartAt < STARTUP_GRACE_MS ? STARTUP_GRACE_MS : BUFFER_GRACE_MS;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.bufferPhase !== 'grace') return;
      const a = this.adapter;
      if (!a || a.readyState() >= 3) {
        this.bufferPhase = 'idle';
        return;
      }
      this.bufferPhase = 'reported';
      this.transport.emit('player:buffering', { buffering: true });
    }, grace);
  }

  private onBufferReady(): void {
    if (this.bufferPhase === 'grace' && this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (this.bufferPhase === 'reported') this.transport.emit('player:buffering', { buffering: false });
    this.bufferPhase = 'idle';
  }

  // ---------- drift correction loop (§6.2) ----------

  private setRateIfChanged(a: MediaAdapter, rate: number): void {
    if (Math.abs(a.getRate() - rate) <= RATE_EPSILON) return;
    this.appliedRate = rate;
    a.setRate(rate);
  }

  private tick(): void {
    const a = this.adapter;
    if (!a) return;
    this.tryAttachApply();
    this.retryPendingApply();
    if (this.bufferPhase === 'reported' && a.readyState() >= 3) this.onBufferReady();
    let drift: number | null = null;
    const cur = this.current;
    if (
      cur &&
      !cur.paused &&
      cur.mode !== 'C' &&
      !this.lock &&
      !this.roomWaiting &&
      this.bufferPhase === 'idle' && // a still-starting client catches up once it plays, not by seeking now
      !this.needsAttachApply &&
      !this.pendingApply &&
      !this.hasPendingIntent() &&
      !a.isSeeking() &&
      !a.isPaused() &&
      !a.isEnded() &&
      this.clockUsable() &&
      cur.updatedAt <= this.clock.serverNow()
    ) {
      const target = expectedPosition(cur, this.clock.serverNow(), a.getDuration());
      drift = a.getPosition() - target;
      const c = computeCorrection(drift, cur.rate, this.clock.rtt, target, a.supportsFineRate);
      if (c.type === 'rate') this.setRateIfChanged(a, c.rate);
      else if (c.type === 'seek' && Date.now() - this.lastDriftSeekAt >= SEEK_LOCK_MAX_MS) {
        // Cooldown: a seek that never lands must not repeat every tick.
        this.lastDriftSeekAt = Date.now();
        this.setRateIfChanged(a, cur.rate);
        this.withRemoteLock((r) => r.seek(c.position));
      }
    }
    this.opts.onStatus?.({
      drift,
      rate: a.getRate(),
      offset: this.clock.offset,
      rtt: this.clock.rtt,
      waiting: this.roomWaiting,
      buffering: this.bufferPhase === 'reported',
    });
  }
}
