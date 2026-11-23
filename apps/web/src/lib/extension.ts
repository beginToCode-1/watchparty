import {
  parseBridgeReply,
  wpHandoffReplySchema,
  wpPingReplySchema,
  type WpHandoffMessage,
  type WpPingReply,
} from '@watchparty/shared-types';

// Web -> extension bridge (docs/EXTENSION_SPEC.md §7.2). `chrome.runtime` only exists on our origin when an
// installed extension lists it in `externally_connectable`, so everything is feature-detected.
const EXTENSION_ID = process.env.NEXT_PUBLIC_EXTENSION_ID ?? '';
const PING_TIMEOUT_MS = 800;
const HANDOFF_TIMEOUT_MS = 5_000;

interface ExternalRuntime {
  sendMessage(extensionId: string, message: unknown, callback: (reply: unknown) => void): void;
  lastError?: { message?: string };
}

function runtime(): ExternalRuntime | null {
  const chromeGlobal: unknown = Reflect.get(globalThis, 'chrome');
  if (typeof chromeGlobal !== 'object' || chromeGlobal === null) return null;
  const rt: unknown = Reflect.get(chromeGlobal, 'runtime');
  if (typeof rt !== 'object' || rt === null || typeof Reflect.get(rt, 'sendMessage') !== 'function') return null;
  return rt as ExternalRuntime;
}

export const extensionConfigured = EXTENSION_ID.length > 0;

function sendToExtension(msg: unknown, timeoutMs: number): Promise<unknown> {
  const rt = runtime();
  if (!EXTENSION_ID || !rt) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    try {
      rt.sendMessage(EXTENSION_ID, msg, (reply) => {
        clearTimeout(t);
        // Reading lastError marks it handled ("Could not establish connection" = not installed).
        resolve(rt.lastError ? null : (reply ?? null));
      });
    } catch {
      clearTimeout(t);
      resolve(null);
    }
  });
}

/** Detects the extension; `null` when not installed, not configured, or not answering. */
export async function pingExtension(): Promise<WpPingReply | null> {
  const reply = parseBridgeReply(await sendToExtension({ type: 'WP_PING' }, PING_TIMEOUT_MS), wpPingReplySchema);
  return reply?.ok ? reply.data : null;
}

/** Hands the room to the extension, which opens/focuses the provider tab. Throws a readable error. */
export async function handoffToExtension(msg: Omit<WpHandoffMessage, 'type'>): Promise<number> {
  const reply = parseBridgeReply(await sendToExtension({ type: 'WP_HANDOFF', ...msg }, HANDOFF_TIMEOUT_MS), wpHandoffReplySchema);
  if (!reply) throw new Error('The extension did not answer. Is it installed and enabled?');
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data.tabId;
}

/** Fallback link the content script understands without the bridge (EXTENSION_SPEC §7.5). */
export function extensionLink(mediaUrl: string, roomCode: string): string {
  const u = new URL(mediaUrl);
  u.hash = `wp=${roomCode}`;
  return u.href;
}
