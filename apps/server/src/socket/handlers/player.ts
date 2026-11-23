import {
  BUFFER_TIMEOUT_MS,
  RESUME_DELAY_MS,
  playerBufferingSchema,
  playerLoadSchema,
  playerPauseSchema,
  playerPlaySchema,
  playerRateSchema,
  playerSeekSchema,
  type MediaInfo,
  type PlaybackState,
  type RoomBufferEvent,
} from '@watchparty/shared-types';
import { classifyWithProbe } from '../../lib/metadata.js';
import { AppError, type BufferRecord, type RoomRecord } from '../../store/types.js';
import { assertControl, member, parse, roomChannel, type Ctx, type Deps } from './context.js';

// ---------- pure state machine (docs/SYNC_PROTOCOL.md §4.3 and §8.2) ----------

/** Side effects collected while mutating; emitted only after the store write succeeded. */
export interface Effects {
  state: boolean;
  buffers: RoomBufferEvent[];
  /** startedAt token of a wait that needs its BUFFER_TIMEOUT_MS timer. */
  waitToken: number | null;
}

export type Intent =
  | { type: 'play'; position: number }
  | { type: 'pause'; position: number }
  | { type: 'seek'; position: number }
  | { type: 'rate'; rate: number };

type LoadTarget = Pick<MediaInfo, 'url' | 'kind' | 'mode'>;

// ponytail: a non-host can still force one <=8 s wait per ~18 s by holding buffering:true; escalate per repeat drop if abused.
/** Per user: one wait start per window, and a dropped straggler stays ignored at least this long (anti stutter-pause). */
const WAIT_COOLDOWN_MS = 10_000;

export const newEffects = (): Effects => ({ state: false, buffers: [], waitToken: null });
export const emptyBuffer = (): BufferRecord => ({ active: false, userIds: [], ignored: [], startedAt: 0, resumeOnClear: false });

export function expectedPos(s: PlaybackState, now: number): number {
  return s.paused ? s.position : s.position + (Math.max(0, now - s.updatedAt) / 1000) * s.rate;
}

export const effective = (b: BufferRecord) => b.userIds.filter((id) => !b.ignored.includes(id));

function setState(room: RoomRecord, patch: Partial<PlaybackState>, byUserId: string | null, fx: Effects): void {
  room.state = { ...room.state, ...patch, seq: room.state.seq + 1, byUserId };
  fx.state = true;
}

function startWait(room: RoomRecord, now: number, fx: Effects): void {
  room.buffer.active = true;
  room.buffer.resumeOnClear = true;
  room.buffer.startedAt = now;
  fx.waitToken = now;
}

function enterWait(room: RoomRecord, now: number, fx: Effects): void {
  setState(room, { position: expectedPos(room.state, now), paused: true, updatedAt: now }, null, fx);
  startWait(room, now, fx);
  fx.buffers.push({ waiting: true, userIds: effective(room.buffer) });
}

function exitWait(room: RoomRecord, now: number, fx: Effects): void {
  room.buffer.active = false;
  if (room.buffer.resumeOnClear) setState(room, { paused: false, updatedAt: now + RESUME_DELAY_MS }, null, fx);
  fx.buffers.push({ waiting: false, userIds: [] });
}

/** 8 s timeout: stragglers move to `ignored`, the room resumes. Idempotent via the startedAt token. */
export function onWaitTimeout(room: RoomRecord, token: number, now: number, fx: Effects): void {
  const b = room.buffer;
  if (!b.active || b.startedAt !== token) return;
  const cooldown = (b.cooldown ??= {});
  for (const id of effective(b)) cooldown[id] = now + WAIT_COOLDOWN_MS;
  // Stragglers stay in userIds (still buffering) so a later buffering:false can tell they recovered.
  b.ignored = [...new Set([...b.ignored, ...b.userIds])];
  exitWait(room, now, fx);
}

/** Resolves a wait whose timer was lost (instance crash); called by every player:* handler and the sweep. */
export function resolveOverdue(room: RoomRecord, now: number, fx: Effects): void {
  if (room.buffer.active && now - room.buffer.startedAt >= BUFFER_TIMEOUT_MS) onWaitTimeout(room, room.buffer.startedAt, now, fx);
}

/** Expired cooldowns go; a dropped straggler that has reported recovery (left userIds) stops being ignored. */
function expireCooldowns(b: BufferRecord, now: number): Record<string, number> {
  const cooldown = (b.cooldown ??= {});
  for (const [id, until] of Object.entries(cooldown)) {
    if (now < until) continue;
    delete cooldown[id];
    if (!b.userIds.includes(id)) b.ignored = b.ignored.filter((x) => x !== id);
  }
  return cooldown;
}

export function applyBuffering(room: RoomRecord, userId: string, buffering: boolean, now: number, fx: Effects): void {
  const b = room.buffer;
  resolveOverdue(room, now, fx);
  const cooldown = expireCooldowns(b, now);
  const until = cooldown[userId] ?? 0;
  if (buffering) {
    if (!b.userIds.includes(userId)) b.userIds.push(userId);
    if (b.ignored.includes(userId)) return; // straggler already dropped
    if (!b.active && !room.state.paused) {
      if (now < until) return; // at most one wait start per user per WAIT_COOLDOWN_MS
      cooldown[userId] = now + WAIT_COOLDOWN_MS;
      enterWait(room, now, fx);
    } else if (b.active) fx.buffers.push({ waiting: true, userIds: effective(b) });
    return;
  }
  b.userIds = b.userIds.filter((id) => id !== userId);
  // Recovered => may trigger future waits, but a dropped straggler only once its cooldown ends (expireCooldowns).
  if (now >= until) b.ignored = b.ignored.filter((id) => id !== userId);
  if (b.active && effective(b).length === 0) exitWait(room, now, fx);
  else if (b.active) fx.buffers.push({ waiting: true, userIds: effective(b) });
}

/** Leave / disconnect: same as buffering:false, but only for a user the buffer record knows. */
export function releaseBuffering(room: RoomRecord, userId: string, now: number, fx: Effects): void {
  if (room.buffer.userIds.includes(userId) || room.buffer.ignored.includes(userId)) {
    applyBuffering(room, userId, false, now, fx);
  }
}

export function applyIntent(room: RoomRecord, intent: Intent, userId: string, now: number, fx: Effects): void {
  const b = room.buffer;
  switch (intent.type) {
    case 'play':
      if (effective(b).length > 0) {
        setState(room, { paused: true, position: intent.position, updatedAt: now }, userId, fx);
        if (b.active) b.resumeOnClear = true;
        else startWait(room, now, fx);
        fx.buffers.push({ waiting: true, userIds: effective(b) });
      } else {
        setState(room, { paused: false, position: intent.position, updatedAt: now }, userId, fx);
      }
      return;
    case 'pause':
      setState(room, { paused: true, position: intent.position, updatedAt: now }, userId, fx);
      b.resumeOnClear = false;
      if (b.active) {
        b.active = false;
        fx.buffers.push({ waiting: false, userIds: [] });
      }
      return;
    case 'seek':
      setState(room, { position: intent.position, updatedAt: now }, userId, fx);
      return;
    case 'rate':
      setState(room, { position: expectedPos(room.state, now), rate: intent.rate, updatedAt: now }, userId, fx);
      return;
  }
}

export function applyLoad(room: RoomRecord, target: LoadTarget, userId: string, now: number, fx: Effects): void {
  const wasWaiting = room.buffer.active;
  setState(
    room,
    { mediaUrl: target.url, kind: target.kind, mode: target.mode, paused: true, position: 0, rate: 1, updatedAt: now },
    userId,
    fx,
  );
  room.buffer = emptyBuffer();
  if (wasWaiting) fx.buffers.push({ waiting: false, userIds: [] });
}

// ---------- store + emit glue ----------

function scheduleWaitTimeout(deps: Deps, code: string, token: number): void {
  const timer = setTimeout(() => {
    deps.timers.delete(timer);
    mutatePlayback(deps, code, (room, now, fx) => onWaitTimeout(room, token, now, fx)).catch((err: unknown) => {
      if (!(err instanceof AppError)) deps.log.error({ err, room: code }, 'buffer timeout failed');
    });
  }, BUFFER_TIMEOUT_MS);
  deps.timers.add(timer);
}

function applyEffects(deps: Deps, code: string, room: RoomRecord, fx: Effects): void {
  const to = deps.io.to(roomChannel(code));
  if (fx.state) to.emit('room:state', { state: room.state });
  for (const b of fx.buffers) to.emit('room:buffer', b);
  if (fx.waitToken !== null) scheduleWaitTimeout(deps, code, fx.waitToken);
}

/** Atomic playback mutation + broadcast. `fn` may throw AppError to reject without writing. */
export async function mutatePlayback(
  deps: Deps,
  code: string,
  fn: (room: RoomRecord, now: number, fx: Effects) => void,
): Promise<RoomRecord> {
  const res = await deps.store.mutateRoom(code, (room) => {
    const fx = newEffects();
    fn(room, Date.now(), fx);
    return fx;
  });
  if (!res) throw new AppError('ROOM_NOT_FOUND', 'Room not found');
  applyEffects(deps, code, res.room, res.result);
  return res.room;
}

/** Safety net for lost timers: resolve overdue waits of rooms that have sockets on this instance. */
export async function sweepOverdue(deps: Deps): Promise<void> {
  const now = Date.now();
  for (const name of deps.io.of('/').adapter.rooms.keys()) {
    if (!name.startsWith('room:')) continue;
    const code = name.slice(5);
    const room = await deps.store.getRoom(code);
    if (room?.buffer.active && now - room.buffer.startedAt >= BUFFER_TIMEOUT_MS) {
      await mutatePlayback(deps, code, (r, t, fx) => resolveOverdue(r, t, fx));
    }
  }
}

/** Load media into the room (player:load and queue:next). Returns the new seq. */
export async function loadMedia(deps: Deps, code: string, userId: string, target: LoadTarget): Promise<number> {
  const room = await mutatePlayback(deps, code, (r, now, fx) => {
    assertControl(r.meta, userId);
    applyLoad(r, target, userId, now, fx);
  });
  return room.state.seq;
}

// ---------- handlers ----------

export function registerPlayerHandlers(ctx: Ctx): void {
  const { on, socket } = ctx;

  const intent = async (make: () => Intent) => {
    const i = make();
    const m = member(socket);
    const room = await mutatePlayback(ctx, m.code, (r, now, fx) => {
      assertControl(r.meta, m.userId);
      resolveOverdue(r, now, fx);
      applyIntent(r, i, m.userId, now, fx);
    });
    return { seq: room.state.seq };
  };

  on('player:play', 'player', (raw) => intent(() => ({ type: 'play', ...parse(playerPlaySchema, raw) })));
  on('player:pause', 'player', (raw) => intent(() => ({ type: 'pause', ...parse(playerPauseSchema, raw) })));
  on('player:seek', 'player', (raw) => intent(() => ({ type: 'seek', ...parse(playerSeekSchema, raw) })));
  on('player:rate', 'player', (raw) => intent(() => ({ type: 'rate', ...parse(playerRateSchema, raw) })));

  on('player:buffering', 'player', async (raw) => {
    const { buffering } = parse(playerBufferingSchema, raw);
    const m = member(socket);
    await mutatePlayback(ctx, m.code, (r, now, fx) => applyBuffering(r, m.userId, buffering, now, fx));
    return null;
  });

  on('player:load', 'player', async (raw) => {
    const { mediaUrl } = parse(playerLoadSchema, raw);
    const m = member(socket);
    const info = await classifyWithProbe(mediaUrl);
    if (!info) throw new AppError('INVALID_PAYLOAD', 'Unsupported media URL');
    const seq = await loadMedia(ctx, m.code, m.userId, info);
    return { seq, kind: info.kind, mode: info.mode };
  });
}
