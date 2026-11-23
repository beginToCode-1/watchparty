import {
  CLOCK_BURST_COUNT,
  CLOCK_INTERVAL_MS,
  CLOCK_MAX_RTT_MS,
  CLOCK_PING_TIMEOUT_MS,
  CLOCK_WINDOW,
  type ClientToServerEvents,
  type RoomBufferEvent,
  type RoomStateEvent,
} from '@watchparty/shared-types';

type EmitMap = Pick<
  ClientToServerEvents,
  'sync:ping' | 'player:play' | 'player:pause' | 'player:seek' | 'player:rate' | 'player:buffering'
>;

/**
 * The slice of a socket.io-client `Socket<ServerToClientEvents, ClientToServerEvents>` the engine uses,
 * so this package never imports socket.io. A real socket is assignable to it as-is
 * (`on`/`off` are overloads, not generics, because socket.io's generic listener types don't unify).
 */
export interface SyncTransport {
  emit<E extends keyof EmitMap>(event: E, ...args: Parameters<EmitMap[E]>): unknown;
  on(event: 'room:state', listener: (p: RoomStateEvent) => void): unknown;
  on(event: 'room:buffer', listener: (p: RoomBufferEvent) => void): unknown;
  on(event: 'connect', listener: () => void): unknown;
  off(event: 'room:state', listener: (p: RoomStateEvent) => void): unknown;
  off(event: 'room:buffer', listener: (p: RoomBufferEvent) => void): unknown;
  off(event: 'connect', listener: () => void): unknown;
}

/** NTP math (docs/SYNC_PROTOCOL.md §3.2). t0/t3 client ms, t1/t2 server ms. */
export function computeClockSample(t0: number, t1: number, t2: number, t3: number): { offset: number; rtt: number } {
  return { offset: (t1 - t0 + (t2 - t3)) / 2, rtt: t3 - t0 - (t2 - t1) };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const hi = s[mid] ?? 0;
  return s.length % 2 === 1 ? hi : ((s[mid - 1] ?? hi) + hi) / 2;
}

/**
 * Estimates server clock offset from `sync:ping` acks: burst of CLOCK_BURST_COUNT sequential pings on start and
 * on every (re)connect, then one every CLOCK_INTERVAL_MS. Offset = min-RTT sample of the last CLOCK_WINDOW
 * (ties: median offset). Environment-neutral (no DOM).
 */
export class ClockSync {
  private samples: { offset: number; rtt: number }[] = [];
  private _offset = 0;
  private _rtt = 0;
  private _burstComplete = false;
  private gen = 0;
  private running = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly onConnect = (): void => {
    if (this.running) this.restart();
  };

  constructor(
    private readonly transport: SyncTransport,
    private readonly now: () => number = Date.now,
  ) {}

  get offset(): number {
    return this._offset;
  }
  get rtt(): number {
    return this._rtt;
  }
  /** At least one valid sample since the last (re)connect. */
  get ready(): boolean {
    return this.samples.length > 0;
  }
  /** The current connection's burst has finished. */
  get burstComplete(): boolean {
    return this._burstComplete;
  }

  serverNow(): number {
    return this.now() + this._offset;
  }

  onUpdate(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.transport.on('connect', this.onConnect);
    this.restart();
    this.interval = setInterval(() => void this.pingOnce(this.gen), CLOCK_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    this.gen++;
    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null;
    this.transport.off('connect', this.onConnect);
  }

  /** Records one exchange. Returns false when discarded (clock step or garbage RTT). */
  addSample(t0: number, t1: number, t2: number, t3: number): boolean {
    const sample = computeClockSample(t0, t1, t2, t3);
    if (sample.rtt < 0 || sample.rtt > CLOCK_MAX_RTT_MS) return false;
    this.samples.push(sample);
    if (this.samples.length > CLOCK_WINDOW) this.samples.splice(0, this.samples.length - CLOCK_WINDOW);
    const minRtt = Math.min(...this.samples.map((s) => s.rtt));
    this._offset = median(this.samples.filter((s) => s.rtt === minRtt).map((s) => s.offset));
    this._rtt = minRtt;
    this.notify();
    return true;
  }

  private restart(): void {
    const gen = ++this.gen;
    this.samples = [];
    this._burstComplete = false;
    void this.burst(gen);
  }

  private async burst(gen: number): Promise<void> {
    for (let i = 0; i < CLOCK_BURST_COUNT; i++) {
      if (gen !== this.gen) return;
      await this.pingOnce(gen);
    }
    if (gen !== this.gen) return;
    this._burstComplete = true;
    this.notify();
  }

  private pingOnce(gen: number): Promise<void> {
    return new Promise((resolve) => {
      const t0 = this.now();
      let done = false;
      const timer = setTimeout(() => {
        done = true;
        resolve();
      }, CLOCK_PING_TIMEOUT_MS);
      this.transport.emit('sync:ping', { t0 }, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const t3 = this.now();
        if (gen === this.gen && res.ok && res.data.t0 === t0) this.addSample(t0, res.data.t1, res.data.t2, t3);
        resolve();
      });
    });
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }
}
