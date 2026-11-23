import cors from '@fastify/cors';
import Fastify, { type FastifyReply } from 'fastify';
import { RATE_LIMITS, metadataQuerySchema, turnQuerySchema, type ErrorCode } from '@watchparty/shared-types';
import { classifyMediaUrl } from '@watchparty/sync-engine/classify';
import type { Env } from './env.js';
import { BlockedTargetError, fetchMetadata } from './lib/metadata.js';
import { KeyedLimiter, ipKey, isTrusted } from './lib/rateLimit.js';
import { turnCredentials } from './lib/turn.js';
import type { RoomStore } from './store/types.js';

export interface Lifecycle {
  shuttingDown: boolean;
}

const httpError = (reply: FastifyReply, status: number, code: ErrorCode, message: string) =>
  reply.code(status).send({ error: { code, message } });

export async function buildApp({ env, store, lifecycle }: { env: Env; store: RoomStore; lifecycle: Lifecycle }) {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Never log query strings (TURN userId, metadata targets) or credentials.
      serializers: {
        req: (req) => ({ method: req.method, url: req.url.split('?')[0], remoteAddress: req.ip }),
      },
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // Trust X-Forwarded-For only from TRUSTED_PROXIES (our nginx), same rule as the socket layer; DEVOPS_AND_SECURITY.md §6.4.
    trustProxy: (addr) => isTrusted(env.TRUSTED_PROXIES, addr),
  });

  await app.register(cors, { origin: env.allowedOrigins, methods: ['GET'], maxAge: 600 });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });

  const limiters = {
    turn: new KeyedLimiter(RATE_LIMITS.turn.capacity, RATE_LIMITS.turn.windowMs),
    metadata: new KeyedLimiter(RATE_LIMITS.metadata.capacity, RATE_LIMITS.metadata.windowMs),
  };
  const limited = (name: keyof typeof limiters, ip: string, reply: FastifyReply): boolean => {
    const retryAfter = limiters[name].take(ipKey(ip));
    if (retryAfter === 0) return false;
    reply.header('Retry-After', String(retryAfter));
    void httpError(reply, 429, 'RATE_LIMITED', 'Too many requests');
    return true;
  };

  app.get('/healthz', async (_req, reply) => {
    const ok = !lifecycle.shuttingDown && (await store.ping());
    return reply.code(ok ? 200 : 503).send({ ok, store: store.kind, uptime: Math.round(process.uptime()) });
  });

  app.get('/api/turn', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (limited('turn', req.ip, reply)) return reply;
    const q = turnQuerySchema.safeParse(req.query);
    if (!q.success) return httpError(reply, 400, 'INVALID_PAYLOAD', 'roomCode and userId are required');
    if (!(await store.hasParticipant(q.data.roomCode, q.data.userId))) {
      return httpError(reply, 403, 'FORBIDDEN', 'Not a participant of this room');
    }
    return turnCredentials({
      secret: env.TURN_SECRET,
      userId: q.data.userId,
      turnUrls: env.TURN_URLS,
      stunUrls: env.STUN_URLS,
    });
  });

  app.get('/api/metadata', async (req, reply) => {
    if (limited('metadata', req.ip, reply)) return reply;
    const q = metadataQuerySchema.safeParse(req.query);
    const info = q.success ? classifyMediaUrl(q.data.url) : null;
    if (!info) return httpError(reply, 400, 'INVALID_PAYLOAD', 'url must be a supported media or page URL');
    try {
      const meta = await fetchMetadata(info);
      reply.header('Cache-Control', 'public, max-age=600');
      return meta;
    } catch (err: unknown) {
      if (err instanceof BlockedTargetError) return httpError(reply, 422, 'INVALID_PAYLOAD', 'Target not allowed');
      throw err;
    }
  });

  return app;
}
