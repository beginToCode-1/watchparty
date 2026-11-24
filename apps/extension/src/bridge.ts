// Extension-internal message contract (docs/EXTENSION_SPEC.md §7.3), shared by background, content script and popup.
import { z } from 'zod';
import {
  drmProviderSchema,
  httpMediaUrlSchema,
  nicknameSchema,
  parseBridgeReply,
  roomCodeSchema,
  serverUrlSchema,
  userIdSchema,
  type BridgeErrorCode,
  type BridgeReply,
} from '@watchparty/shared-types';
import { classifyMediaUrl } from '@watchparty/sync-engine';

export const SESSION_KEY = 'wp:session';
export const NICKNAME_KEY = 'wp:nickname';
export const COLLAPSED_KEY = 'wp:sidebarCollapsed';
export const SERVER_KEY = 'wp:server';
export const ALL_SITES = ['https://*/*', 'http://*/*'];
export const DYNAMIC_SCRIPT_ID = 'wp-all';

export const sessionSchema = z.object({
  roomCode: roomCodeSchema,
  nickname: nicknameSchema,
  mediaUrl: httpMediaUrlSchema,
  serverUrl: serverUrlSchema,
  provider: drmProviderSchema.nullable(),
  tabId: z.number().int().nullable(),
  userId: userIdSchema.nullable(),
  createdAt: z.number().int(),
});
export type Session = z.infer<typeof sessionSchema>;

export const sessionSetSchema = z.object({
  type: z.literal('WP_SESSION_SET'),
  roomCode: roomCodeSchema,
  nickname: nicknameSchema,
  mediaUrl: httpMediaUrlSchema,
  serverUrl: serverUrlSchema,
  userId: userIdSchema.optional(),
  tabId: z.number().int().optional(),
});

export const internalMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('WP_SESSION_GET') }),
  sessionSetSchema,
  z.object({ type: z.literal('WP_SESSION_CLEAR') }),
  z.object({ type: z.literal('WP_SIDEBAR_TOGGLE') }),
  z.object({ type: z.literal('WP_MAIN_BRIDGE') }),
]);
export type InternalMessage = z.infer<typeof internalMessageSchema>;

export const emptySchema = z.object({});

export const ok = <T>(data: T): BridgeReply<T> => ({ ok: true, data });
export const fail = <T = never>(code: BridgeErrorCode, message: string): BridgeReply<T> => ({
  ok: false,
  error: { code, message },
});

type DataSchema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

export async function sendToBackground<T>(msg: InternalMessage, data: DataSchema<T>): Promise<BridgeReply<T>> {
  try {
    return parseBridgeReply(await chrome.runtime.sendMessage(msg), data) ?? fail('INVALID_PAYLOAD', 'Malformed reply');
  } catch (err: unknown) {
    return fail('TAB_ERROR', err instanceof Error ? err.message : 'Background unavailable');
  }
}

export async function sendToTab<T>(tabId: number, msg: InternalMessage, data: DataSchema<T>): Promise<BridgeReply<T>> {
  try {
    const raw: unknown = await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
    return parseBridgeReply(raw, data) ?? fail('INVALID_PAYLOAD', 'Malformed reply');
  } catch (err: unknown) {
    return fail('TAB_ERROR', err instanceof Error ? err.message : 'No content script in tab');
  }
}

/** Hostname without a leading `www.`. Throws on an invalid URL. */
export const bareHost = (url: string | URL): string => new URL(url).hostname.replace(/^www\./, '');

/** URL without its fragment; null for anything that is not http(s). */
export function stripHash(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** Same streaming site: same DRM provider, or (no provider) the same host ignoring a leading `www.`. */
export function sameSite(a: string, b: string): boolean {
  const pa = classifyMediaUrl(a)?.provider;
  const pb = classifyMediaUrl(b)?.provider;
  if (pa || pb) return pa === pb;
  try {
    return bareHost(a) === bareHost(b);
  } catch {
    return false;
  }
}

/** Same page for sync purposes: origin + path. ponytail: ignores the query (Netflix adds ?trackId=); add per-site
 *  significant params (YouTube `v`) if a Mode B attempt on such a site ever needs it. */
export function samePage(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname.replace(/\/$/, '') === ub.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}

export async function readLocal(key: string): Promise<unknown> {
  try {
    return (await chrome.storage.local.get(key))[key];
  } catch {
    return undefined;
  }
}

/** Last server a room was joined on (written by the content script after a successful join), else the build default. */
export async function lastServerUrl(): Promise<string> {
  const parsed = serverUrlSchema.safeParse(await readLocal(SERVER_KEY));
  return parsed.success ? parsed.data : import.meta.env.VITE_SERVER_URL;
}

/** `wp=CODE[@host]` link fragment. Only https servers carry their host: `#wp=CODE@host` is read back as https://host. */
export function wpHash(roomCode: string, serverUrl: string): string {
  const u = new URL(serverUrl);
  return u.protocol === 'https:' ? `wp=${roomCode}@${u.host}` : `wp=${roomCode}`;
}

/** Web app origin for a server. shortcut: any non-default server is assumed to serve the web app from its own
 *  origin (the one-origin tunnel setup); add a separate web URL to the session if split deployments need it. */
export const webUrlFor = (serverUrl: string): string =>
  serverUrl === import.meta.env.VITE_SERVER_URL ? import.meta.env.VITE_WEB_URL : serverUrl;
