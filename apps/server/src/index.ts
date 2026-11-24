import { Redis } from 'ioredis';
import { buildApp, type Lifecycle } from './app.js';
import { env } from './env.js';
import { attachSocket } from './socket/index.js';
import { MemoryStore } from './store/memory.js';
import { RedisStore } from './store/redis.js';
import type { RoomStore } from './store/types.js';

const redisOpts = { maxRetriesPerRequest: 3, enableAutoPipelining: true };

let store: RoomStore;
let adapter: { pub: Redis; sub: Redis } | undefined;
if (env.REDIS_URL) {
  store = new RedisStore(new Redis(env.REDIS_URL, redisOpts), env.ROOM_TTL_SECONDS);
  const pub = new Redis(env.REDIS_URL, redisOpts);
  adapter = { pub, sub: pub.duplicate() };
} else {
  store = new MemoryStore(env.ROOM_TTL_SECONDS);
}

const lifecycle: Lifecycle = { shuttingDown: false };
const app = await buildApp({ env, store, lifecycle });
const sockets = attachSocket(app.server, { store, env, log: app.log }, adapter);

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (err: unknown) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}
app.log.info(`store=${store.kind} listening on ${env.HOST}:${env.PORT}`);

async function shutdown(signal: string): Promise<void> {
  if (lifecycle.shuttingDown) return;
  lifecycle.shuttingDown = true; // /healthz now answers 503
  app.log.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 10_000).unref();
  await sockets.close(); // bounded by the force-exit above
  await app.close();
  await store.close();
  if (adapter) await Promise.allSettled([adapter.pub.quit(), adapter.sub.quit()]);
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    shutdown(signal).catch((err: unknown) => {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    });
  });
}
