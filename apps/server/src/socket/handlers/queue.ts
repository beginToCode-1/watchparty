import { randomUUID } from 'node:crypto';
import {
  QUEUE_MAX,
  QUEUE_TITLE_MAX,
  queueAddSchema,
  queueNextSchema,
  queueRemoveSchema,
  type MediaInfo,
  type QueueItem,
} from '@watchparty/shared-types';
import { cachedTitle, classifyWithProbe } from '../../lib/metadata.js';
import { sanitizeTitle } from '../../lib/sanitize.js';
import { AppError } from '../../store/types.js';
import { assertControl, member, parse, roomChannel, type Ctx } from './context.js';
import { loadMedia } from './player.js';

function defaultTitle(info: MediaInfo): string {
  const local = /^local:(.+)$/.exec(info.url)?.[1];
  if (local) return sanitizeTitle(local) ?? 'Local file';
  const u = URL.parse(info.url);
  if (!u) return info.url.slice(0, QUEUE_TITLE_MAX);
  return (sanitizeTitle(`${u.hostname}${u.pathname === '/' ? '' : u.pathname}`) ?? u.hostname).slice(0, QUEUE_TITLE_MAX);
}

export function registerQueueHandlers(ctx: Ctx): void {
  const { on, socket, store, io } = ctx;
  const broadcastQueue = async (code: string) => {
    io.to(roomChannel(code)).emit('queue:update', { queue: await store.getQueue(code) });
  };

  on('queue:add', 'player', async (raw) => {
    const p = parse(queueAddSchema, raw);
    const m = member(socket);
    const info = await classifyWithProbe(p.mediaUrl);
    if (!info) throw new AppError('INVALID_PAYLOAD', 'Unsupported media URL');
    const title = (p.title !== undefined ? sanitizeTitle(p.title) : null) ?? cachedTitle(info.url) ?? defaultTitle(info);
    const item: QueueItem = { id: randomUUID(), mediaUrl: info.url, title, addedBy: m.userId, kind: info.kind, mode: info.mode };
    if (!(await store.pushQueue(m.code, item, QUEUE_MAX))) throw new AppError('INVALID_PAYLOAD', 'Queue is full');
    await broadcastQueue(m.code);
    return { item };
  });

  on('queue:remove', 'player', async (raw) => {
    const { id } = parse(queueRemoveSchema, raw);
    const m = member(socket);
    const [room, queue] = await Promise.all([store.getRoom(m.code), store.getQueue(m.code)]);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 'Room not found');
    const item = queue.find((q) => q.id === id);
    if (!item) throw new AppError('INVALID_PAYLOAD', 'Unknown queue item');
    if (item.addedBy !== m.userId && room.meta.hostId !== m.userId) {
      throw new AppError('FORBIDDEN', 'Only the host or the person who added it can remove it');
    }
    if (await store.removeQueue(m.code, id)) await broadcastQueue(m.code);
    return null;
  });

  on('queue:next', 'player', async (raw) => {
    parse(queueNextSchema, raw);
    const m = member(socket);
    const room = await store.getRoom(m.code);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 'Room not found');
    assertControl(room.meta, m.userId);
    const item = await store.popQueue(m.code);
    if (!item) throw new AppError('INVALID_PAYLOAD', 'Queue is empty');
    await broadcastQueue(m.code);
    const seq = await loadMedia(ctx, m.code, m.userId, { url: item.mediaUrl, kind: item.kind, mode: item.mode });
    return { seq, kind: item.kind, mode: item.mode };
  });
}
