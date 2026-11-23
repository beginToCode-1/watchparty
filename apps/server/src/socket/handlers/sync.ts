import { syncPingSchema } from '@watchparty/shared-types';
import { parse, type Ctx } from './context.js';

/** NTP-style ping: t1 = arrival (before rate limit + parse), t2 = just before the ack. The ack is the pong. */
export function registerSyncHandlers(ctx: Ctx): void {
  ctx.on('sync:ping', 'sync', async (raw, t1) => {
    const { t0 } = parse(syncPingSchema, raw);
    return { t0, t1, t2: Date.now() };
  });
}
