// MV3 service worker: stateless router + session store (docs/EXTENSION_SPEC.md §4, §7).
//
// Socket ownership: the Socket.IO connection lives in the CONTENT SCRIPT, not here. Chrome kills an idle MV3
// service worker after ~30 s; a socket held here would drop mid-movie (and keeping the worker alive needs
// offscreen-document or keep-alive tricks). The content script lives exactly as long as the tab that plays the
// video, which is the lifetime the room seat should have. So this file holds no in-memory truth: everything it
// remembers is in chrome.storage.session, and every listener is registered synchronously at top level.
import {
  PROVIDER_MATCHES,
  externalMessageSchema,
  type BridgeReply,
  type WpHandoffMessage,
  type WpHandoffReply,
  type WpPingReply,
} from '@watchparty/shared-types';
import { classifyMediaUrl } from '@watchparty/sync-engine';
import contentScript from './content/index.tsx?script';
import {
  ALL_SITES,
  DYNAMIC_SCRIPT_ID,
  SESSION_KEY,
  emptySchema,
  fail,
  internalMessageSchema,
  ok,
  sameSite,
  sendToTab,
  sessionSchema,
  stripHash,
  type InternalMessage,
  type Session,
} from './bridge';

const WEB_ORIGIN = new URL(import.meta.env.VITE_WEB_URL).origin;
const NETFLIX_HOST = /(?:^|\.)netflix\.com$/;

// ---------- session storage ----------

async function readSession(): Promise<Session | null> {
  const raw: unknown = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  const parsed = sessionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function setBadge(session: Session): Promise<void> {
  if (session.tabId === null) return;
  const tabId = session.tabId;
  const allSites = await chrome.permissions.contains({ origins: ALL_SITES });
  const covered = session.provider !== null || allSites;
  await chrome.action.setBadgeBackgroundColor({ tabId, color: covered ? '#0a84ff' : '#ff9f0a' }).catch(() => undefined);
  await chrome.action.setBadgeText({ tabId, text: covered ? 'ON' : '!' }).catch(() => undefined);
  await chrome.action
    .setTitle({ tabId, title: covered ? `WatchParty · room ${session.roomCode}` : 'Click to join the party on this tab' })
    .catch(() => undefined);
}

async function clearBadge(tabId: number | null): Promise<void> {
  if (tabId === null) return;
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
  await chrome.action.setTitle({ tabId, title: 'WatchParty' }).catch(() => undefined);
}

async function writeSession(session: Session): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: session });
  await setBadge(session);
}

/** Points the session at `tabId`, clearing a session held by another tab (its content script leaves the room). */
async function replaceSession(
  m: { roomCode: string; nickname: string; mediaUrl: string; userId?: string | undefined },
  tabId: number,
): Promise<Session> {
  const old = await readSession();
  if (old && old.tabId !== null && old.tabId !== tabId) await clearSession(true);
  const keep = old && old.tabId === tabId && old.roomCode === m.roomCode;
  const session: Session = {
    roomCode: m.roomCode,
    nickname: m.nickname,
    mediaUrl: m.mediaUrl,
    provider: classifyMediaUrl(m.mediaUrl)?.provider ?? null,
    tabId,
    userId: m.userId ?? (keep ? old.userId : null),
    createdAt: keep ? old.createdAt : Date.now(),
  };
  await writeSession(session);
  return session;
}

/** Removes the session; `notifyTab` forwards WP_SESSION_CLEAR so the content script leaves the room. */
async function clearSession(notifyTab: boolean, exceptTabId?: number): Promise<void> {
  const old = await readSession();
  await chrome.storage.session.remove(SESSION_KEY);
  if (!old) return;
  await clearBadge(old.tabId);
  if (notifyTab && old.tabId !== null && old.tabId !== exceptTabId) {
    await sendToTab(old.tabId, { type: 'WP_SESSION_CLEAR' }, emptySchema);
  }
}

// ---------- external: web app -> background ----------

async function focusTab(tab: chrome.tabs.Tab): Promise<chrome.tabs.Tab | undefined> {
  if (tab.id === undefined) return undefined;
  const updated = await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  return updated ?? tab;
}

async function handoff(m: WpHandoffMessage): Promise<BridgeReply<WpHandoffReply>> {
  const target = stripHash(m.mediaUrl);
  if (!target) return fail('INVALID_PAYLOAD', 'mediaUrl must be http(s)');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.id !== undefined && t.url !== undefined && stripHash(t.url) === target);

  let tab: chrome.tabs.Tab | undefined;
  try {
    if (existing) {
      tab = await focusTab(existing);
    } else {
      const url = new URL(m.mediaUrl);
      if (!url.hash) url.hash = `wp=${m.roomCode}`;
      tab = await chrome.tabs.create({ url: url.href, active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
    }
  } catch (e: unknown) {
    return fail('TAB_ERROR', e instanceof Error ? e.message : 'Could not open the tab');
  }
  if (tab?.id === undefined) return fail('TAB_ERROR', 'Could not open the tab');
  const tabId = tab.id;

  await replaceSession(m, tabId);
  // An already-loaded tab has a running content script: tell it to join now. A new tab finds the session on boot.
  if (existing) {
    await sendToTab(tabId, { type: 'WP_SESSION_SET', roomCode: m.roomCode, nickname: m.nickname, mediaUrl: m.mediaUrl }, emptySchema);
  }
  return ok({ tabId });
}

async function handleExternal(raw: unknown, sender: chrome.runtime.MessageSender): Promise<BridgeReply<unknown>> {
  let origin: string | null = null;
  try {
    origin = new URL(sender.origin ?? sender.url ?? '').origin;
  } catch {
    origin = null;
  }
  if (origin !== WEB_ORIGIN) return fail('FORBIDDEN', 'Origin not allowed');
  const parsed = externalMessageSchema.safeParse(raw);
  if (!parsed.success) return fail('INVALID_PAYLOAD', 'Invalid message');
  const msg = parsed.data;
  if (msg.type === 'WP_PING') {
    const reply: WpPingReply = { version: chrome.runtime.getManifest().version, hasSession: (await readSession()) !== null };
    return ok(reply);
  }
  return handoff(msg);
}

// ---------- internal: content script / popup -> background ----------

function netflixSeekBridge(): void {
  // Runs in the page's MAIN world (serialized by executeScript): self-contained, no closures.
  interface NetflixPlayer {
    seek(ms: number): void;
  }
  interface NetflixVideoPlayer {
    getAllPlayerSessionIds?: () => string[];
    getVideoPlayerBySessionId?: (id: string) => NetflixPlayer | undefined;
  }
  interface NetflixWindow {
    __wpBridge?: boolean;
    netflix?: { appContext?: { state?: { playerApp?: { getAPI?: () => { videoPlayer?: NetflixVideoPlayer } } } } };
  }
  const w = window as unknown as NetflixWindow;
  if (w.__wpBridge) return;
  w.__wpBridge = true;
  document.addEventListener('wp:seek', (e: Event) => {
    const ms = Number((e as CustomEvent<unknown>).detail);
    if (!Number.isFinite(ms) || ms < 0) return;
    const vp = w.netflix?.appContext?.state?.playerApp?.getAPI?.().videoPlayer;
    const id = vp?.getAllPlayerSessionIds?.()[0];
    if (vp && id !== undefined) vp.getVideoPlayerBySessionId?.(id)?.seek(ms);
  });
}

async function handleInternal(msg: InternalMessage, sender: chrome.runtime.MessageSender): Promise<BridgeReply<unknown>> {
  const fromTab = sender.tab?.id;
  switch (msg.type) {
    case 'WP_SESSION_GET': {
      const s = await readSession();
      if (fromTab === undefined) return ok(s);
      return ok(s && s.tabId === fromTab ? s : null);
    }
    case 'WP_SESSION_SET': {
      const tabId = fromTab ?? msg.tabId;
      if (tabId === undefined) return fail('INVALID_PAYLOAD', 'tabId required');
      const session = await replaceSession(msg, tabId);
      if (tabId !== fromTab) await sendToTab(tabId, { ...msg, tabId }, emptySchema);
      return ok(session);
    }
    case 'WP_SESSION_CLEAR':
      await clearSession(true, fromTab);
      return ok({});
    case 'WP_MAIN_BRIDGE': {
      let host = '';
      try {
        host = new URL(sender.tab?.url ?? '').hostname;
      } catch {
        host = '';
      }
      if (fromTab === undefined || !NETFLIX_HOST.test(host)) return fail('FORBIDDEN', 'Netflix tabs only');
      await chrome.scripting.executeScript({ target: { tabId: fromTab }, world: 'MAIN', func: netflixSeekBridge });
      return ok({});
    }
    case 'WP_SIDEBAR_TOGGLE':
      return fail('INVALID_PAYLOAD', 'WP_SIDEBAR_TOGGLE is sent to tabs, not the background');
  }
}

function respond(work: Promise<BridgeReply<unknown>>, sendResponse: (r: BridgeReply<unknown>) => void): true {
  work.then(sendResponse, (e: unknown) => sendResponse(fail('TAB_ERROR', e instanceof Error ? e.message : 'Failed')));
  return true;
}

chrome.runtime.onMessageExternal.addListener((raw: unknown, sender, sendResponse) =>
  respond(handleExternal(raw, sender), sendResponse),
);

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const parsed = internalMessageSchema.safeParse(raw);
  if (!parsed.success) {
    sendResponse(fail('INVALID_PAYLOAD', 'Unknown message'));
    return false;
  }
  return respond(handleInternal(parsed.data, sender), sendResponse);
});

// ---------- tab tracking ----------

chrome.tabs.onRemoved.addListener((tabId) => {
  void readSession().then((s) => (s?.tabId === tabId ? clearSession(false) : undefined));
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  const url = info.url;
  if (url === undefined) return;
  void readSession().then(async (s) => {
    if (!s || s.tabId !== tabId) return;
    if (!sameSite(url, s.mediaUrl)) await clearSession(false);
    else await setBadge(s); // per-tab badge resets on navigation
  });
});

// ---------- keyboard command ----------

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-sidebar') return;
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id !== undefined) void sendToTab(tab.id, { type: 'WP_SIDEBAR_TOGGLE' }, emptySchema);
  });
});

// ---------- optional all-sites access (popup "Enable on all sites") ----------

async function syncDynamicScript(): Promise<void> {
  const granted = await chrome.permissions.contains({ origins: ALL_SITES });
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
  if (granted && registered.length === 0) {
    await chrome.scripting.registerContentScripts([
      {
        id: DYNAMIC_SCRIPT_ID,
        matches: ALL_SITES,
        excludeMatches: PROVIDER_MATCHES,
        js: [contentScript],
      },
    ]);
  } else if (!granted && registered.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
  }
}

chrome.permissions.onAdded.addListener(() => void syncDynamicScript());
chrome.permissions.onRemoved.addListener(() => void syncDynamicScript());
chrome.runtime.onInstalled.addListener(() => void syncDynamicScript());
