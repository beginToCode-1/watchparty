import type { FastifyBaseLogger } from 'fastify';
import type { Server, Socket } from 'socket.io';
import type { z } from 'zod';
import type {
  AckCallback,
  C2SEventName,
  ClientToServerEvents,
  InterServerEvents,
  Participant,
  ServerToClientEvents,
  SocketData,
} from '@watchparty/shared-types';
import type { Env } from '../../env.js';
import type { BucketName } from '../../lib/rateLimit.js';
import { AppError, type ParticipantRecord, type RoomMeta, type RoomStore } from '../../store/types.js';

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export type AckData<E extends C2SEventName> =
  NonNullable<Parameters<ClientToServerEvents[E]>[1]> extends AckCallback<infer T> ? T : never;

/** Process-wide dependencies shared by every connection. */
export interface Deps {
  io: IoServer;
  store: RoomStore;
  env: Env;
  log: FastifyBaseLogger;
  /** Wait-for-buffer timers on this instance, cleared on shutdown. */
  timers: Set<NodeJS.Timeout>;
}

/**
 * Handler: receives the raw payload (it parses it itself, so `room:join` can check the lockout first), the time the
 * event arrived, and `after(fn)` to run `fn` once the ack has been sent.
 */
export type Handler<E extends C2SEventName> = (
  raw: unknown,
  receivedAt: number,
  after: (fn: () => void) => void,
) => Promise<AckData<E>>;

export interface Ctx extends Deps {
  socket: IoSocket;
  on<E extends C2SEventName>(event: E, bucket: BucketName, handler: Handler<E>): void;
}

export const roomChannel = (code: string) => `room:${code}`;
export const userChannel = (userId: string) => `user:${userId}`;

export function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new AppError('INVALID_PAYLOAD', issue ? `${issue.path.join('.') || 'payload'}: ${issue.message}` : 'Invalid payload');
  }
  return r.data;
}

export function member(socket: IoSocket): { code: string; userId: string; nickname: string } {
  const { roomCode, userId, nickname } = socket.data;
  if (!roomCode || !userId || nickname === undefined) throw new AppError('FORBIDDEN', 'Not in a room');
  return { code: roomCode, userId, nickname };
}

export function assertControl(meta: RoomMeta, userId: string): void {
  if (meta.hostOnlyControl && meta.hostId !== userId) throw new AppError('FORBIDDEN', 'Only the host can control playback');
}

export const toWire = (list: ParticipantRecord[], hostId: string): Participant[] =>
  list.map((p) => ({ id: p.id, nickname: p.nickname, isHost: p.id === hostId, joinedAt: p.joinedAt, media: p.media }));

export function broadcastParticipants(deps: Deps, code: string, list: ParticipantRecord[], hostId: string): void {
  if (list.length === 0) return;
  deps.io.to(roomChannel(code)).emit('room:participants', { participants: toWire(list, hostId), hostId });
}
