import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { Server } from 'socket.io';
import type { Ack, ErrorCode } from '@watchparty/shared-types';
import { clientIp, createSocketLimiter } from '../lib/rateLimit.js';
import { AppError } from '../store/types.js';
import type { Ctx, Deps, IoServer } from './handlers/context.js';
import { registerChatHandlers } from './handlers/chat.js';
import { registerPlayerHandlers, sweepOverdue } from './handlers/player.js';
import { registerQueueHandlers } from './handlers/queue.js';
import { registerRoomHandlers } from './handlers/room.js';
import { registerRtcHandlers } from './handlers/rtc.js';
import { registerSyncHandlers } from './handlers/sync.js';

const SWEEP_MS = 2_000;
const RATE_ERROR_INTERVAL_MS = 1_000;
const DROP_WINDOW_MS = 60_000;
const DROP_DISCONNECT = 100;

export interface SocketLayer {
  /** Disconnects this instance's sockets and stops timers (the HTTP server is closed by Fastify). */
  close(): void;
}

export function attachSocket(
  httpServer: HttpServer,
  deps: Omit<Deps, 'io' | 'timers'>,
  adapter?: { pub: Redis; sub: Redis },
): SocketLayer {
  // Websocket only (CLAUDE.md D3): no polling => no sticky sessions and no CORS; Origin is not an auth boundary.
  const io: IoServer = new Server(httpServer, {
    transports: ['websocket'],
    serveClient: false,
    maxHttpBufferSize: 65_536,
    connectTimeout: 10_000,
  });
  if (adapter) io.adapter(createAdapter(adapter.pub, adapter.sub));
  const d: Deps = { ...deps, io, timers: new Set() };

  io.on('connection', (socket) => {
    socket.data.ip = clientIp(socket.handshake.address, socket.handshake.headers['x-forwarded-for'], d.env.TRUSTED_PROXIES);
    const limit = createSocketLimiter();
    let lastRateError = 0;
    let drops: number[] = [];
    d.log.debug({ sid: socket.id }, 'socket connected');

    const fail = (event: string, err: unknown, reply: ((res: Ack<never>) => void) | null) => {
      const code: ErrorCode = err instanceof AppError ? err.code : 'INTERNAL';
      const message = err instanceof AppError ? err.message : 'Internal error';
      if (code === 'INTERNAL') d.log.error({ err, event, room: socket.data.roomCode }, 'handler failed');
      if (reply) return reply({ ok: false, error: { code, message } });
      if (code === 'RATE_LIMITED') {
        const now = Date.now();
        if (now - lastRateError < RATE_ERROR_INTERVAL_MS) return;
        lastRateError = now;
      }
      socket.emit('error', { code, message });
    };

    const on: Ctx['on'] = (event, bucket, handler) => {
      const listener = (raw: unknown, ack?: unknown) => {
        const receivedAt = Date.now();
        const reply = typeof ack === 'function' ? (ack as (res: Ack<unknown>) => void) : null;
        if (!limit(bucket)) {
          drops = drops.filter((t) => receivedAt - t < DROP_WINDOW_MS);
          drops.push(receivedAt);
          if (drops.length > DROP_DISCONNECT) {
            d.log.warn({ ip: socket.data.ip, room: socket.data.roomCode, event }, 'rate-limit abuse, disconnecting');
            socket.disconnect(true);
            return;
          }
          return fail(event, new AppError('RATE_LIMITED', 'Too many requests'), reply);
        }
        const afterAck: (() => void)[] = [];
        handler(raw, receivedAt, (fn) => afterAck.push(fn)).then(
          (data) => {
            reply?.({ ok: true, data });
            for (const fn of afterAck) fn();
          },
          (err: unknown) => fail(event, err, reply),
        );
      };
      // The listener validates its own payload, so it is typed `unknown` and adapted to the event's signature.
      socket.on(event, listener as Parameters<typeof socket.on<typeof event>>[1]);
    };

    const ctx: Ctx = { ...d, socket, on };
    registerRoomHandlers(ctx);
    registerSyncHandlers(ctx);
    registerPlayerHandlers(ctx);
    registerChatHandlers(ctx);
    registerQueueHandlers(ctx);
    registerRtcHandlers(ctx);
    socket.on('disconnect', (reason) => d.log.debug({ sid: socket.id, reason }, 'socket disconnected'));
  });

  const sweep = setInterval(() => {
    sweepOverdue(d).catch((err: unknown) => d.log.error({ err }, 'overdue buffer sweep failed'));
  }, SWEEP_MS);
  sweep.unref();

  return {
    close() {
      clearInterval(sweep);
      for (const t of d.timers) clearTimeout(t);
      d.timers.clear();
      io.local.disconnectSockets(true);
    },
  };
}
