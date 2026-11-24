import { existsSync } from 'node:fs';
import { z } from 'zod';
import { proxyList } from './lib/rateLimit.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const list = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    );

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  CORS_ORIGINS: list('http://localhost:3000'),
  EXTENSION_IDS: list('kgeaggokfampiakpipghoaeockijhbai'), // pinned by the extension manifest `key`
  REDIS_URL: z
    .string()
    .trim()
    .optional()
    .transform((s) => (s ? s : undefined)),
  // Same-origin gateway: unmatched requests are proxied to the Next.js app (one tunnel, one origin). Origin only.
  WEB_UPSTREAM: z
    .string()
    .trim()
    .optional()
    .transform((s, ctx) => {
      if (!s) return undefined;
      const u = URL.parse(s);
      if (u?.protocol !== 'http:' || u.pathname !== '/' || u.search || u.username) {
        ctx.addIssue({ code: 'custom', message: 'must be a plain http:// origin, e.g. http://127.0.0.1:3000' });
        return z.NEVER;
      }
      return u;
    }),
  TURN_SECRET: z.string().default(''),
  TURN_URLS: list('turn:localhost:3478?transport=udp,turn:localhost:3478?transport=tcp'),
  STUN_URLS: list('stun:stun.l.google.com:19302'),
  ROOM_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Peers whose X-Forwarded-For is believed (our nginx). Loopback only by default.
  TRUSTED_PROXIES: list('127.0.0.1/8,::1/128').transform((l, ctx) => {
    try {
      return proxyList(l);
    } catch (err: unknown) {
      ctx.addIssue({ code: 'custom', message: (err as Error).message });
      return z.NEVER;
    }
  }),
});

export type Env = z.infer<typeof envSchema> & { allowedOrigins: string[] };

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) console.error(`${issue.path.join('.')}: ${issue.message}`);
    process.exit(1);
  }
  const e = parsed.data;
  return { ...e, allowedOrigins: [...e.CORS_ORIGINS, ...e.EXTENSION_IDS.map((id) => `chrome-extension://${id}`)] };
}

export const env = parseEnv(process.env);
