import { randomUUID } from 'node:crypto';
import {
  CHAT_HISTORY_ON_JOIN,
  CREATE_MAX,
  EMPTY_ROOM_TTL_S,
  JOIN_FAIL_MAX,
  JOIN_FAIL_WINDOW_S,
  MAX_PARTICIPANTS,
  roomCodeSchema,
  roomCreateSchema,
  roomJoinSchema,
  roomLeaveSchema,
  roomSettingsSchema,
  type PlaybackState,
} from '@watchparty/shared-types';
import { classifyWithProbe } from '../../lib/metadata.js';
import { ipKey } from '../../lib/rateLimit.js';
import { generateRoomCode } from '../../lib/roomCode.js';
import { sanitizeNickname } from '../../lib/sanitize.js';
import { AppError, type ParticipantRecord } from '../../store/types.js';
import { broadcastParticipants, member, parse, roomChannel, toWire, userChannel, type Ctx, type Deps, type Handler, type IoSocket } from './context.js';
import { effective, emptyBuffer, mutatePlayback, releaseBuffering } from './player.js';

const CODE_ATTEMPTS = 5;
const noMedia = () => ({ audio: false, video: false, screen: false });

/** Remove a participant: buffer cleanup (may resume the room), host hand-off to the oldest member, broadcast. */
async function removeUser(deps: Deps, code: string, userId: string): Promise<void> {
  const removed = await deps.store.removeParticipant(code, userId);
  const before = await deps.store.listParticipants(code);
  let hostChanged = false;
  let room = await mutatePlayback(deps, code, (r, now, fx) => {
    releaseBuffering(r, userId, now, fx);
    hostChanged = false;
    const next = before[0];
    if (r.meta.hostId === userId && next) {
      r.meta.hostId = next.id;
      hostChanged = true;
    }
  });
  // `before` may be stale (a concurrent leave on another instance): re-read, and re-pick only if the host is gone.
  const remaining = await deps.store.listParticipants(code);
  const fresh = remaining[0];
  if (fresh && !remaining.some((p) => p.id === room.meta.hostId)) {
    const res = await deps.store.mutateRoom(code, (r) => {
      if (!remaining.some((p) => p.id === r.meta.hostId)) r.meta.hostId = fresh.id;
    });
    if (res) room = res.room;
    hostChanged = true;
  }
  if (removed || hostChanged) broadcastParticipants(deps, code, remaining, room.meta.hostId);
  if (remaining.length === 0) {
    // Empty rooms must not live for ROOM_TTL_SECONDS (create spam); keep a short reconnect grace instead.
    await deps.store.expireRoom(code, EMPTY_ROOM_TTL_S);
    if ((await deps.store.listParticipants(code)).length > 0) await deps.store.touch(code); // a join raced in
  }
}

function bind(socket: IoSocket, code: string, userId: string, nickname: string): void {
  socket.data.roomCode = code;
  socket.data.userId = userId;
  socket.data.nickname = nickname;
  void socket.join([roomChannel(code), userChannel(userId)]);
}

function unbind(socket: IoSocket): void {
  const { roomCode, userId } = socket.data;
  if (roomCode) void socket.leave(roomChannel(roomCode));
  if (userId) void socket.leave(userChannel(userId));
  delete socket.data.roomCode;
  delete socket.data.userId;
  delete socket.data.nickname;
}

/** Leave the socket's current room, if any (explicit leave, disconnect, or implicit on create/join). */
async function leaveCurrent(ctx: Ctx): Promise<void> {
  const { roomCode, userId } = ctx.socket.data;
  unbind(ctx.socket);
  if (!roomCode || !userId) return;
  try {
    await removeUser(ctx, roomCode, userId);
  } catch (err: unknown) {
    if (!(err instanceof AppError)) throw err; // room already expired: nothing to clean up
  }
}

/** The socket disconnected while create/join was awaiting: its disconnect cleanup may have run too early, redo it. */
async function abortIfGone(ctx: Ctx, code: string, userId: string): Promise<void> {
  if (ctx.socket.connected) return;
  unbind(ctx.socket);
  await removeUser(ctx, code, userId);
  throw new AppError('FORBIDDEN', 'Disconnected');
}

/** Drop participants whose socket is gone cluster-wide (ghosts of a crashed instance). Best effort. */
async function reconcile(ctx: Ctx, code: string): Promise<void> {
  let live: Set<string | undefined>;
  try {
    live = new Set((await ctx.io.in(roomChannel(code)).fetchSockets()).map((s) => s.data.userId));
  } catch {
    return; // adapter timeout: skip, the join still succeeds
  }
  for (const p of await ctx.store.listParticipants(code)) {
    if (!live.has(p.id)) await removeUser(ctx, code, p.id);
  }
}

export function registerRoomHandlers(ctx: Ctx): void {
  const { on, socket, store } = ctx;

  const create: Handler<'room:create'> = async (raw, _at, after) => {
    const p = parse(roomCreateSchema, raw);
    const nickname = sanitizeNickname(p.nickname);
    if (!nickname) throw new AppError('INVALID_PAYLOAD', 'nickname: invalid after sanitizing');
    // Rate-limit before the outbound URL probe, so create spam can't drive server-side fetches.
    if ((await store.incrCounter(`ratelimit:create:${ipKey(socket.data.ip)}`, JOIN_FAIL_WINDOW_S)) > CREATE_MAX) {
      throw new AppError('RATE_LIMITED', 'Too many rooms created, try again later');
    }
    const info = p.mediaUrl === undefined ? null : await classifyWithProbe(p.mediaUrl);
    if (p.mediaUrl !== undefined && !info) throw new AppError('INVALID_PAYLOAD', 'Unsupported media URL');
    await leaveCurrent(ctx);

    const userId = randomUUID();
    const now = Date.now();
    const state: PlaybackState = {
      mediaUrl: info?.url ?? null,
      mode: info?.mode ?? null,
      kind: info?.kind ?? null,
      paused: true,
      position: 0,
      rate: 1,
      updatedAt: now,
      seq: info ? 1 : 0,
      byUserId: info ? userId : null,
    };
    const host: ParticipantRecord = { id: userId, nickname, joinedAt: now, media: noMedia() };
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const code = generateRoomCode();
      const meta = { code, hostId: userId, hostOnlyControl: false };
      if (!(await store.createRoom({ meta, state, buffer: emptyBuffer() }, host))) continue;
      bind(socket, code, userId, nickname);
      await abortIfGone(ctx, code, userId);
      after(() => socket.emit('room:settings', { hostOnlyControl: false }));
      return { roomCode: code, userId, state, participants: toWire([host], userId) };
    }
    throw new Error('room code collision retries exhausted');
  };

  const join: Handler<'room:join'> = async (raw, _at, after) => {
    const ip = ipKey(socket.data.ip);
    const joinKey = `ratelimit:join:${ip}`;
    // Reserve the attempt atomically before looking anything up: concurrent joins can't all pass a stale read,
    // and a locked-out IP learns nothing. Refunded once the code names a real room (only bad guesses count).
    // ponytail: >10 simultaneous valid joins from one IP briefly see TOO_MANY_ATTEMPTS; per-IP queueing if NAT'd groups hit it.
    const n = await store.incrCounter(joinKey, JOIN_FAIL_WINDOW_S);
    if (n > JOIN_FAIL_MAX) {
      if (n === JOIN_FAIL_MAX + 1) ctx.log.warn({ ip }, 'join failures limit reached');
      throw new AppError('TOO_MANY_ATTEMPTS', 'Too many failed join attempts, try again later');
    }
    const rawCode = typeof raw === 'object' && raw !== null && 'roomCode' in raw ? raw.roomCode : undefined;
    const codeParse = roomCodeSchema.safeParse(rawCode);
    if (!codeParse.success) throw new AppError('INVALID_PAYLOAD', 'roomCode: invalid');
    if (!(await store.getRoom(codeParse.data))) throw new AppError('ROOM_NOT_FOUND', 'Room not found');
    await store.decrCounter(joinKey);

    const p = parse(roomJoinSchema, raw);
    const nickname = sanitizeNickname(p.nickname);
    if (!nickname) throw new AppError('INVALID_PAYLOAD', 'nickname: invalid after sanitizing');
    const code = p.roomCode;

    await leaveCurrent(ctx);
    await reconcile(ctx, code);
    const userId = randomUUID();
    const me: ParticipantRecord = { id: userId, nickname, joinedAt: Date.now(), media: noMedia() };
    // Bind before adding, so a concurrent join's reconcile sees this socket as live.
    bind(socket, code, userId, nickname);
    try {
      const added = await store.addParticipant(code, me, MAX_PARTICIPANTS);
      if (added === 'not_found') throw new AppError('ROOM_NOT_FOUND', 'Room not found');
      if (added === 'full') throw new AppError('ROOM_FULL', 'Room is full');
      const list = await store.listParticipants(code);
      const ids = new Set(list.map((x) => x.id));
      const res = await store.mutateRoom(code, (r) => {
        if (!ids.has(r.meta.hostId)) r.meta.hostId = userId; // empty room (or departed host): joiner becomes host
      });
      if (!res) throw new AppError('ROOM_NOT_FOUND', 'Room not found');
      const { meta, state, buffer } = res.room;
      const [chat, queue] = await Promise.all([store.recentChat(code, CHAT_HISTORY_ON_JOIN), store.getQueue(code)]);
      await abortIfGone(ctx, code, userId); // last await: a later disconnect finds roomCode bound and cleans up itself
      after(() => {
        socket.emit('room:settings', { hostOnlyControl: meta.hostOnlyControl });
        if (buffer.active) {
          socket.emit('room:buffer', { waiting: true, userIds: effective(buffer) });
        }
        broadcastParticipants(ctx, code, list, meta.hostId);
      });
      return { roomCode: code, userId, hostId: meta.hostId, state, participants: toWire(list, meta.hostId), chat, queue };
    } catch (err: unknown) {
      unbind(socket);
      await store.removeParticipant(code, userId).catch(() => false);
      throw err;
    }
  };

  // One create/join at a time per socket: two overlapping ones could each bind and leave a ghost participant.
  let joining = false;
  const exclusive = async <T>(run: () => Promise<T>): Promise<T> => {
    if (joining) throw new AppError('RATE_LIMITED', 'Already creating or joining a room, wait for it to finish');
    joining = true;
    try {
      return await run();
    } finally {
      joining = false;
    }
  };
  on('room:create', 'player', (raw, at, after) => exclusive(() => create(raw, at, after)));
  on('room:join', 'player', (raw, at, after) => exclusive(() => join(raw, at, after)));

  on('room:leave', 'player', async (raw) => {
    parse(roomLeaveSchema, raw);
    member(socket);
    await leaveCurrent(ctx);
    return null;
  });

  on('room:settings', 'player', async (raw) => {
    const p = parse(roomSettingsSchema, raw);
    const m = member(socket);
    const res = await store.mutateRoom(m.code, (r) => {
      if (r.meta.hostId !== m.userId) throw new AppError('FORBIDDEN', 'Only the host can change settings');
      if (p.hostOnlyControl !== undefined) r.meta.hostOnlyControl = p.hostOnlyControl;
      return r.meta.hostOnlyControl;
    });
    if (!res) throw new AppError('ROOM_NOT_FOUND', 'Room not found');
    ctx.io.to(roomChannel(m.code)).emit('room:settings', { hostOnlyControl: res.result });
    return { hostOnlyControl: res.result };
  });

  socket.on('disconnect', () => {
    const done = leaveCurrent(ctx)
      .catch((err: unknown) => ctx.log.error({ err }, 'disconnect cleanup failed'))
      .finally(() => ctx.cleanups.delete(done));
    ctx.cleanups.add(done);
  });
}
