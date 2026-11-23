import { CHAT_HISTORY_MAX, type ChatMessage, type MediaFlags, type QueueItem } from '@watchparty/shared-types';
import { byJoinOrder, type ParticipantRecord, type RoomRecord, type RoomStore } from './types.js';

interface Entry {
  room: RoomRecord;
  participants: Map<string, ParticipantRecord>;
  chat: ChatMessage[];
  queue: QueueItem[];
  expiresAt: number;
}

/** Single-instance store (REDIS_URL unset). Node's single thread makes every method atomic. */
export class MemoryStore implements RoomStore {
  readonly kind = 'memory';
  private readonly rooms = new Map<string, Entry>();
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly ttlSeconds: number,
    private readonly now: () => number = Date.now,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  private sweep(): void {
    const t = this.now();
    for (const [code, e] of this.rooms) if (e.expiresAt <= t) this.rooms.delete(code);
    for (const [k, f] of this.counters) if (f.expiresAt <= t) this.counters.delete(k);
  }

  /** Live entry, optionally refreshing its TTL (activity). */
  private entry(code: string, touch = false): Entry | null {
    const e = this.rooms.get(code);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.rooms.delete(code);
      return null;
    }
    if (touch) e.expiresAt = this.now() + this.ttlSeconds * 1000;
    return e;
  }

  async createRoom(room: RoomRecord, host: ParticipantRecord): Promise<boolean> {
    if (this.entry(room.meta.code)) return false;
    this.rooms.set(room.meta.code, {
      room: structuredClone(room),
      participants: new Map([[host.id, structuredClone(host)]]),
      chat: [],
      queue: [],
      expiresAt: this.now() + this.ttlSeconds * 1000,
    });
    return true;
  }

  async getRoom(code: string): Promise<RoomRecord | null> {
    const e = this.entry(code);
    return e ? structuredClone(e.room) : null;
  }

  async mutateRoom<T>(code: string, fn: (room: RoomRecord) => T): Promise<{ room: RoomRecord; result: T } | null> {
    const e = this.entry(code);
    if (!e) return null;
    const draft = structuredClone(e.room);
    const result = fn(draft); // throws => nothing written
    e.room = draft;
    e.expiresAt = this.now() + this.ttlSeconds * 1000;
    return { room: structuredClone(draft), result };
  }

  async touch(code: string): Promise<boolean> {
    return this.entry(code, true) !== null;
  }

  async addParticipant(code: string, p: ParticipantRecord, max: number): Promise<'ok' | 'not_found' | 'full'> {
    const e = this.entry(code, true);
    if (!e) return 'not_found';
    if (e.participants.size >= max) return 'full';
    e.participants.set(p.id, structuredClone(p));
    return 'ok';
  }

  async removeParticipant(code: string, userId: string): Promise<boolean> {
    const e = this.entry(code, true);
    return e ? e.participants.delete(userId) : false;
  }

  async listParticipants(code: string): Promise<ParticipantRecord[]> {
    const e = this.entry(code);
    return e ? [...e.participants.values()].map((p) => structuredClone(p)).sort(byJoinOrder) : [];
  }

  async hasParticipant(code: string, userId: string): Promise<boolean> {
    return this.entry(code)?.participants.has(userId) ?? false;
  }

  async setParticipantMedia(code: string, userId: string, media: MediaFlags): Promise<boolean> {
    const p = this.entry(code, true)?.participants.get(userId);
    if (!p) return false;
    p.media = { ...media };
    return true;
  }

  async appendChat(code: string, msg: ChatMessage): Promise<void> {
    const e = this.entry(code, true);
    if (!e) return;
    e.chat.push(structuredClone(msg));
    if (e.chat.length > CHAT_HISTORY_MAX) e.chat.splice(0, e.chat.length - CHAT_HISTORY_MAX);
  }

  async recentChat(code: string, n: number): Promise<ChatMessage[]> {
    return structuredClone(this.entry(code)?.chat.slice(-n) ?? []);
  }

  async getQueue(code: string): Promise<QueueItem[]> {
    return structuredClone(this.entry(code)?.queue ?? []);
  }

  async pushQueue(code: string, item: QueueItem, max: number): Promise<boolean> {
    const e = this.entry(code, true);
    if (!e || e.queue.length >= max) return false;
    e.queue.push(structuredClone(item));
    return true;
  }

  async removeQueue(code: string, id: string): Promise<boolean> {
    const e = this.entry(code, true);
    const i = e?.queue.findIndex((q) => q.id === id) ?? -1;
    if (!e || i === -1) return false;
    e.queue.splice(i, 1);
    return true;
  }

  async popQueue(code: string): Promise<QueueItem | null> {
    return this.entry(code, true)?.queue.shift() ?? null;
  }

  async expireRoom(code: string, seconds: number): Promise<void> {
    const e = this.entry(code);
    if (e) e.expiresAt = this.now() + seconds * 1000;
  }

  async incrCounter(key: string, windowS: number): Promise<number> {
    const t = this.now();
    const f = this.counters.get(key);
    if (!f || f.expiresAt <= t) {
      // Fixed window: the TTL is set on the first hit and not extended (like Redis EXPIRE NX).
      this.counters.set(key, { count: 1, expiresAt: t + windowS * 1000 });
      return 1;
    }
    return ++f.count;
  }

  async decrCounter(key: string): Promise<void> {
    const f = this.counters.get(key);
    if (f && f.expiresAt > this.now() && f.count > 0) f.count--;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
  }
}
