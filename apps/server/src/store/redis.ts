import { setTimeout } from 'node:timers/promises';
import type { ChainableCommander, Redis } from 'ioredis';
import { CHAT_HISTORY_MAX, type ChatMessage, type MediaFlags, type QueueItem } from '@watchparty/shared-types';
import { byJoinOrder, type ParticipantRecord, type RoomRecord, type RoomStore } from './types.js';

const keys = (code: string) => ({
  room: `room:${code}`,
  participants: `room:${code}:participants`,
  chat: `room:${code}:chat`,
  queue: `room:${code}:queue`,
});

const MUTATE_RETRIES = 5;

function parseRoom(h: Record<string, string>): RoomRecord | null {
  if (!h.meta || !h.state || !h.buffer) return null;
  return { meta: JSON.parse(h.meta) as RoomRecord['meta'], state: JSON.parse(h.state) as RoomRecord['state'], buffer: JSON.parse(h.buffer) as RoomRecord['buffer'] };
}

/** First reply of a MULTI, or throws if the transaction or the command failed. */
function firstReply(res: [Error | null, unknown][] | null): unknown {
  const first = res?.[0];
  if (!first) throw new Error('redis transaction aborted');
  if (first[0]) throw first[0];
  return first[1];
}

export class RedisStore implements RoomStore {
  readonly kind = 'redis';
  /** WATCH is connection-scoped, so optimistic transactions run on their own connection, one at a time. */
  private readonly tx: Redis;
  private txChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {
    this.tx = redis.duplicate();
  }

  /** Queue EXPIRE on all four room keys (TTL refresh rides in the same MULTI as the write). */
  private expireAll(m: ChainableCommander, code: string, ttl = this.ttlSeconds): ChainableCommander {
    for (const key of Object.values(keys(code))) m.expire(key, ttl);
    return m;
  }

  async createRoom(room: RoomRecord, host: ParticipantRecord): Promise<boolean> {
    const k = keys(room.meta.code);
    if ((await this.redis.hsetnx(k.room, 'meta', JSON.stringify(room.meta))) === 0) return false;
    const m = this.redis
      .multi()
      .hset(k.room, { state: JSON.stringify(room.state), buffer: JSON.stringify(room.buffer) })
      .hset(k.participants, host.id, JSON.stringify(host));
    firstReply(await this.expireAll(m, room.meta.code).exec());
    return true;
  }

  async getRoom(code: string): Promise<RoomRecord | null> {
    return parseRoom(await this.redis.hgetall(keys(code).room));
  }

  // ponytail: one serialized WATCH connection per instance; a small pool of tx connections if mutation rate grows.
  mutateRoom<T>(code: string, fn: (room: RoomRecord) => T): Promise<{ room: RoomRecord; result: T } | null> {
    const run = this.txChain.then(() => this.mutateWatched(code, fn));
    this.txChain = run.catch(() => undefined);
    return run;
  }

  private async mutateWatched<T>(code: string, fn: (room: RoomRecord) => T): Promise<{ room: RoomRecord; result: T } | null> {
    const k = keys(code);
    for (let attempt = 0; attempt < MUTATE_RETRIES; attempt++) {
      await this.tx.watch(k.room);
      const room = parseRoom(await this.tx.hgetall(k.room));
      if (!room) {
        await this.tx.unwatch();
        return null;
      }
      let result: T;
      try {
        result = fn(room);
      } catch (err: unknown) {
        await this.tx.unwatch();
        throw err;
      }
      const m = this.tx.multi().hset(k.room, {
        meta: JSON.stringify(room.meta),
        state: JSON.stringify(room.state),
        buffer: JSON.stringify(room.buffer),
      });
      const res = await this.expireAll(m, code).exec();
      if (res !== null) {
        firstReply(res);
        return { room, result };
      }
    }
    throw new Error(`room ${code}: write contention after ${MUTATE_RETRIES} attempts`);
  }

  async touch(code: string): Promise<boolean> {
    return firstReply(await this.expireAll(this.redis.multi(), code).exec()) === 1;
  }

  async addParticipant(code: string, p: ParticipantRecord, max: number): Promise<'ok' | 'not_found' | 'full'> {
    const k = keys(code);
    if ((await this.redis.exists(k.room)) === 0) return 'not_found';
    if ((await this.redis.hlen(k.participants)) >= max) return 'full';
    firstReply(await this.expireAll(this.redis.multi().hset(k.participants, p.id, JSON.stringify(p)), code).exec());
    // Two instances can both pass the check above; re-check after the write.
    if ((await this.redis.hlen(k.participants)) > max) {
      await this.redis.hdel(k.participants, p.id);
      return 'full';
    }
    return 'ok';
  }

  async removeParticipant(code: string, userId: string): Promise<boolean> {
    const m = this.redis.multi().hdel(keys(code).participants, userId);
    return firstReply(await this.expireAll(m, code).exec()) === 1;
  }

  async listParticipants(code: string): Promise<ParticipantRecord[]> {
    const raw = await this.redis.hvals(keys(code).participants);
    return raw.map((s) => JSON.parse(s) as ParticipantRecord).sort(byJoinOrder);
  }

  async hasParticipant(code: string, userId: string): Promise<boolean> {
    return (await this.redis.hexists(keys(code).participants, userId)) === 1;
  }

  async setParticipantMedia(code: string, userId: string, media: MediaFlags): Promise<boolean> {
    const k = keys(code);
    const raw = await this.redis.hget(k.participants, userId);
    if (!raw) return false;
    const p = { ...(JSON.parse(raw) as ParticipantRecord), media };
    firstReply(await this.expireAll(this.redis.multi().hset(k.participants, userId, JSON.stringify(p)), code).exec());
    return true;
  }

  async appendChat(code: string, msg: ChatMessage): Promise<void> {
    const k = keys(code);
    const m = this.redis.multi().rpush(k.chat, JSON.stringify(msg)).ltrim(k.chat, -CHAT_HISTORY_MAX, -1);
    firstReply(await this.expireAll(m, code).exec());
  }

  async recentChat(code: string, n: number): Promise<ChatMessage[]> {
    const raw = await this.redis.lrange(keys(code).chat, -n, -1);
    return raw.map((s) => JSON.parse(s) as ChatMessage);
  }

  async getQueue(code: string): Promise<QueueItem[]> {
    const raw = await this.redis.lrange(keys(code).queue, 0, -1);
    return raw.map((s) => JSON.parse(s) as QueueItem);
  }

  async pushQueue(code: string, item: QueueItem, max: number): Promise<boolean> {
    const k = keys(code);
    if ((await this.redis.llen(k.queue)) >= max) return false;
    firstReply(await this.expireAll(this.redis.multi().rpush(k.queue, JSON.stringify(item)), code).exec());
    return true;
  }

  async removeQueue(code: string, id: string): Promise<boolean> {
    const k = keys(code);
    const raw = (await this.redis.lrange(k.queue, 0, -1)).find((s) => (JSON.parse(s) as QueueItem).id === id);
    if (raw === undefined) return false;
    return Number(firstReply(await this.expireAll(this.redis.multi().lrem(k.queue, 1, raw), code).exec())) > 0;
  }

  async popQueue(code: string): Promise<QueueItem | null> {
    const raw = firstReply(await this.expireAll(this.redis.multi().lpop(keys(code).queue), code).exec());
    return typeof raw === 'string' ? (JSON.parse(raw) as QueueItem) : null;
  }

  async expireRoom(code: string, seconds: number): Promise<void> {
    await this.expireAll(this.redis.multi(), code, seconds).exec();
  }

  async incrCounter(key: string, windowS: number): Promise<number> {
    const res = await this.redis.multi().incr(key).expire(key, windowS, 'NX').exec();
    return Number(firstReply(res));
  }

  async decrCounter(key: string): Promise<void> {
    // Only while the key lives: a DECR on an expired key would create a counter without a TTL.
    await this.redis.eval("if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('DECR', KEYS[1]) end return 0", 1, key);
  }

  async ping(): Promise<boolean> {
    try {
      return await Promise.race([this.redis.ping().then((r) => r === 'PONG'), setTimeout(500, false, { ref: false })]);
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.tx.quit(), this.redis.quit()]);
  }
}
