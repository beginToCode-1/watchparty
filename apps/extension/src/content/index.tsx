// Content script entry (docs/EXTENSION_SPEC.md §8): owns the socket, ClockSync, SyncController and the sidebar.
import { createRoot, type Root } from 'react-dom/client';
import { io, type Socket } from 'socket.io-client';
import {
  CHAT_HISTORY_MAX,
  ROOM_CODE_ALPHABET,
  serverUrlSchema,
  type ClientToServerEvents,
  type ErrorCode,
  type PlaybackState,
  type ReactionEmoji,
  type RoomStateEvent,
  type ServerToClientEvents,
} from '@watchparty/shared-types';
import { ClockSync, SyncController, classifyMediaUrl, type SyncTransport } from '@watchparty/sync-engine';
import type { HTMLVideoAdapter } from '@watchparty/sync-engine';
import {
  COLLAPSED_KEY,
  NICKNAME_KEY,
  SERVER_KEY,
  bareHost,
  emptySchema,
  fail,
  internalMessageSchema,
  lastServerUrl,
  ok,
  readLocal,
  samePage,
  sameSite,
  sendToBackground,
  sessionSchema,
  stripHash,
  wpHash,
  type InternalMessage,
} from '../bridge';
import { Sidebar, type SidebarActions } from './sidebar/Sidebar';
import sidebarCss from './sidebar/sidebar.css?inline';
import { initialView, useRoom } from './sidebar/store';
import { createAdapter, isSiteAdShowing, largeCrossOriginIframe, watchPrimaryVideo, type VideoWatcher } from './video-finder';

type WpSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// `#wp=CODE` or `#wp=CODE@host[:port]` (https server). The host charset keeps paths and credentials out.
const HASH_RE = new RegExp(`(?:^#|&)wp=([${ROOM_CODE_ALPHABET}]{6})(?:@([A-Za-z0-9.-]+(?::[0-9]{1,5})?))?(?:&|$)`);
const PAGE_POLL_MS = 1000;
const IFRAME_HINT_MS = 10_000;
const NO_VIDEO_MS = 30_000;
const REACTION_TTL_MS = 3000;
const TOAST_MS = 4000;
const RATE_LIMIT_TOAST_GAP_MS = 5000;

const set = useRoom.setState;
const pageProvider = (): string | null => classifyMediaUrl(location.href)?.provider ?? null;

// No FORBIDDEN entry: the server's message says which rule applies ('Not in a room' is not the host-only rule).
const ERROR_TEXT: Partial<Record<ErrorCode, string>> = {
  ROOM_NOT_FOUND: 'That room does not exist or has expired.',
  ROOM_FULL: 'That room is full (12 people max).',
  TOO_MANY_ATTEMPTS: 'Too many failed attempts. Try again in a few minutes.',
  RATE_LIMITED: 'Slow down a little.',
};

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string): void {
  set({ toast: text });
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => set({ toast: null }), TOAST_MS);
}

/**
 * The server stores `unknown` pages as Mode C (tab share), and SyncController ignores Mode C. In the extension we
 * are the "Try with extension" Mode B attempt on that page, so incoming states are presented to the controller as B.
 */
const asB = (s: PlaybackState): PlaybackState => (s.mode === 'C' ? { ...s, mode: 'B' } : s);

/**
 * The socket as the engine's transport: room states reach the controller as Mode B, and emits are dropped rather
 * than queued while there is no seat. socket.io buffers emits made while disconnected and flushes them BEFORE the
 * reconnect's room:join, so a queued player:* (detach's buffering:false, say) would fail with FORBIDDEN 'Not in a room'.
 */
function modeBTransport(socket: WpSocket, inRoom: () => boolean): SyncTransport {
  type Ev = 'room:state' | 'room:buffer' | 'connect';
  type StateL = (p: RoomStateEvent) => void;
  const wrapped = new Map<unknown, StateL>();
  const send = socket.emit.bind(socket) as SyncTransport['emit'];
  return {
    emit: (event, ...args) => socket.connected && (event === 'sync:ping' || inRoom()) && send(event, ...args),
    on: (event: Ev, l: (p: never) => void) => {
      if (event !== 'room:state') return socket.on(event, l as never);
      const w: StateL = (p) => (l as StateL)({ state: asB(p.state) });
      wrapped.set(l, w);
      return socket.on(event, w);
    },
    off: (event: Ev, l: (p: never) => void) => {
      const w = event === 'room:state' ? wrapped.get(l) : l;
      wrapped.delete(l);
      return w && socket.off(event, w as never); // never off(event, undefined): that drops every listener
    },
  };
}

// ---------- sidebar host (§6.1, §6.5) ----------

let host: HTMLElement | null = null;
let reactRoot: Root | null = null;
let hostObserver: MutationObserver | null = null;

function placeHost(): void {
  if (!host) return;
  const fe = document.fullscreenElement;
  if (fe instanceof HTMLVideoElement) {
    host.style.display = 'none'; // a fullscreen <video> cannot show children
    return;
  }
  host.style.display = 'block';
  const parent = fe ?? document.documentElement;
  if (host.parentNode !== parent) parent.appendChild(host);
}

function mount(): void {
  if (host) return;
  host = document.createElement('watchparty-root');
  host.style.cssText =
    'all:initial;display:block;position:fixed;top:0;right:0;height:100vh;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = sidebarCss;
  shadow.appendChild(style);
  const mountPoint = document.createElement('div');
  mountPoint.id = 'wp-root';
  shadow.appendChild(mountPoint);
  // Keep the page's keyboard shortcuts (space, f, k, arrows) and focus traps out of our UI. Bubble phase at the
  // shadow root: React (listening on mountPoint) has already handled the event.
  for (const type of ['keydown', 'keyup', 'keypress', 'focusin', 'focusout']) {
    shadow.addEventListener(type, (e) => {
      e.stopImmediatePropagation();
    });
  }
  document.documentElement.appendChild(host); // <html>, not <body>: SPAs replace <body>
  placeHost();
  hostObserver = new MutationObserver(() => {
    if (host && !host.isConnected) placeHost();
  });
  hostObserver.observe(document.documentElement, { childList: true });
  document.addEventListener('fullscreenchange', placeHost);
  reactRoot = createRoot(mountPoint);
  reactRoot.render(<Sidebar actions={actions} />);
}

function unmount(): void {
  hostObserver?.disconnect();
  hostObserver = null;
  document.removeEventListener('fullscreenchange', placeHost);
  reactRoot?.unmount();
  reactRoot = null;
  host?.remove();
  host = null;
}

// ---------- connection ----------

let conn: ReturnType<typeof connect> | null = null;

function connect(roomCode: string, nickname: string, serverUrl: string) {
  const socket: WpSocket = io(serverUrl, {
    transports: ['websocket'], // content-script requests carry the page Origin; websocket is not subject to CORS
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 10_000,
  });
  let joined = false;
  const transport = modeBTransport(socket, () => joined);
  const clock = new ClockSync(transport);
  const provider = pageProvider();
  let adapter: HTMLVideoAdapter | null = null;
  let attached = false;
  let closed = false;
  let adShowing = false;
  let lastHref = location.href;
  let searchingSince = Date.now();
  let lastRateToast = 0;

  const controller = new SyncController({
    transport,
    clock,
    onMediaChange: (state) => {
      attached = false;
      const url = state.mediaUrl;
      if (url !== null && !samePage(url, location.href)) {
        const info = classifyMediaUrl(url);
        const next = new URL(url);
        const here = bareHost(location.href);
        const there = bareHost(next);
        const sameHost = next.protocol === 'https:' && (there === here || there.endsWith(`.${here}`) || here.endsWith(`.${there}`));
        if (info?.mode === 'B' && info.provider !== undefined && info.provider === provider && sameHost) {
          next.hash = wpHash(roomCode, serverUrl);
          location.assign(next.href); // reload boots us again; the session brings us back into the room
          return;
        }
        set({ notice: { kind: 'switched', url } });
      }
      reconcile();
    },
    onAutoplayBlocked: () => set({ autoplayBlocked: true }),
    onIntentRejected: (e) => toast(ERROR_TEXT[e.code] ?? e.message),
    onStatus: (status) => {
      const n = useRoom.getState().notice;
      if (n?.kind === 'manualSeek' && status.drift !== null && Math.abs(status.drift) < 0.5) set({ notice: null });
      set({ sync: status });
    },
  });

  const canControl = (): boolean => {
    const s = useRoom.getState();
    return !s.hostOnlyControl || s.hostId === s.userId;
  };

  /** Attach the controller only when joined, a video exists, this tab shows the party's media and no ad plays. */
  function reconcile(): void {
    if (closed) return;
    const partyUrl = controller.state?.mediaUrl ?? null;
    const onParty = partyUrl === null || samePage(partyUrl, location.href);
    const want = joined && adapter !== null && onParty && !adShowing;
    if (want && adapter && !attached) {
      controller.attach(adapter);
      attached = true;
    } else if (!want && attached) {
      controller.detach();
      attached = false;
    }
    const notice = useRoom.getState().notice;
    if (onParty) {
      if (notice?.kind === 'navigated' || notice?.kind === 'switched') set({ notice: null });
    } else if (joined && partyUrl !== null && notice?.kind !== 'switched') {
      const canLoad = sameSite(location.href, partyUrl) && canControl();
      if (notice?.kind !== 'navigated' || notice.canLoad !== canLoad || notice.partyUrl !== partyUrl) {
        set({ notice: { kind: 'navigated', partyUrl, canLoad } });
      }
    }
  }

  const watcher: VideoWatcher = watchPrimaryVideo((video) => {
    if (attached) controller.detach();
    attached = false;
    adapter?.destroy();
    adapter = video ? createAdapter(video, provider, (position) => set({ notice: { kind: 'manualSeek', position } })) : null;
    if (!video) searchingSince = Date.now();
    set({ video: video ? 'syncing' : 'searching', autoplayBlocked: false });
    reconcile();
  }, provider !== null);

  const pagePoll = setInterval(() => {
    // Orphaned by an extension reload/update: the new copy takes the seat, so this one leaves and removes its UI.
    if (!chrome.runtime?.id) return endSession(false);
    const ad = isSiteAdShowing();
    if (ad !== adShowing && joined) {
      adShowing = ad;
      if (ad) {
        reconcile(); // detach first: it may report buffering:false for a pending stall
        socket.emit('player:buffering', { buffering: true });
      } else {
        socket.emit('player:buffering', { buffering: false });
        reconcile(); // re-attach applies the room state with a hard seek
      }
    }
    if (location.href !== lastHref) {
      lastHref = location.href;
      reconcile();
    }
    if (!adapter) {
      const elapsed = Date.now() - searchingSince;
      const view = useRoom.getState();
      if (elapsed >= NO_VIDEO_MS && view.video !== 'missing') set({ video: 'missing' });
      if (elapsed >= IFRAME_HINT_MS && view.notice === null) {
        const frame = largeCrossOriginIframe();
        if (frame) set({ notice: { kind: 'iframe', src: frame.src } });
      }
    }
  }, PAGE_POLL_MS);
  const onPop = (): void => reconcile();
  window.addEventListener('popstate', onPop);

  function join(): void {
    socket.emit('room:join', { roomCode, nickname }, (res) => {
      if (closed) return;
      if (!res.ok) {
        set({ phase: 'error', error: ERROR_TEXT[res.error.code] ?? res.error.message });
        socket.disconnect();
        return;
      }
      const d = res.data;
      joined = true;
      set({
        phase: 'joined',
        error: null,
        roomCode: d.roomCode,
        userId: d.userId,
        hostId: d.hostId,
        participants: d.participants,
        chat: d.chat,
        queue: d.queue,
      });
      controller.applyState(asB(d.state));
      reconcile();
      const mediaUrl = stripHash(location.href);
      if (mediaUrl) {
        void sendToBackground(
          { type: 'WP_SESSION_SET', roomCode: d.roomCode, nickname, mediaUrl, serverUrl, userId: d.userId },
          sessionSchema,
        );
      }
      void chrome.storage.local.set({ [NICKNAME_KEY]: nickname, [SERVER_KEY]: serverUrl }).catch(() => undefined);
      if (HASH_RE.test(location.hash)) {
        const rest = location.hash.replace(/^#/, '').split('&').filter((p) => !p.startsWith('wp=')).join('&');
        history.replaceState(history.state, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`);
        lastHref = location.href;
      }
    });
  }

  socket.on('connect', () => {
    set({ phase: 'connecting' });
    join(); // every (re)connect is a fresh join; the server issues a new userId (contract D7)
  });
  socket.on('disconnect', () => {
    joined = false;
    reconcile();
    if (!closed && useRoom.getState().phase !== 'error') set({ phase: 'reconnecting' });
  });
  socket.on('connect_error', () => {
    if (!closed && useRoom.getState().phase !== 'error') set({ phase: 'reconnecting' });
  });
  socket.on('room:state', () => reconcile());
  socket.on('room:participants', (p) => set({ participants: p.participants, hostId: p.hostId }));
  socket.on('room:settings', (p) => {
    set({ hostOnlyControl: p.hostOnlyControl });
    reconcile();
  });
  socket.on('room:buffer', (p) => set({ buffer: p }));
  socket.on('queue:update', (p) => set({ queue: p.queue }));
  socket.on('chat:message', (m) => {
    const s = useRoom.getState();
    const unread = s.collapsed ? s.unread + (m.userId !== s.userId ? 1 : 0) : 0;
    set({ chat: [...s.chat, m].slice(-CHAT_HISTORY_MAX), unread });
  });
  socket.on('reaction', (r) => {
    set({ reactions: [...useRoom.getState().reactions, r] });
    setTimeout(() => set({ reactions: useRoom.getState().reactions.filter((x) => x.id !== r.id) }), REACTION_TTL_MS);
  });
  socket.on('error', (e) => {
    if (e.code === 'RATE_LIMITED') {
      if (Date.now() - lastRateToast < RATE_LIMIT_TOAST_GAP_MS) return;
      lastRateToast = Date.now();
    }
    toast(ERROR_TEXT[e.code] ?? e.message);
  });

  set({ phase: 'connecting', roomCode, nickname, error: null });
  clock.start();

  return {
    roomCode,
    serverUrl,
    controller,
    /** Chat and reactions only while seated: socket.io would flush them before the reconnect's room:join. */
    emitIfJoined: (send: (socket: WpSocket) => void): void => {
      if (joined && socket.connected) send(socket);
    },
    seekLocal: (seconds: number) => {
      if (!adapter) return toast('No video to seek yet');
      if (!canControl()) return toast('Only the host can control playback in this room.');
      adapter.seek(seconds); // the resulting `seeked` becomes a normal player:seek intent
    },
    loadHere: () => {
      const mediaUrl = stripHash(location.href);
      if (!mediaUrl) return;
      if (!joined) return toast('Reconnecting… try again in a moment.');
      set({ notice: null });
      socket.emit('player:load', { mediaUrl }, (res) => {
        if (!res.ok) toast(ERROR_TEXT[res.error.code] ?? res.error.message);
      });
    },
    rescan: () => {
      searchingSince = Date.now();
      set({ video: 'searching' });
      if (useRoom.getState().notice?.kind === 'iframe') set({ notice: null });
      watcher.rescan();
    },
    close: (sendLeave: boolean) => {
      closed = true;
      if (sendLeave && socket.connected) socket.emit('room:leave', {});
      clearInterval(pagePoll);
      window.removeEventListener('popstate', onPop);
      watcher.dispose();
      controller.destroy();
      clock.stop();
      adapter?.destroy();
      adapter = null;
      socket.disconnect();
    },
  };
}

function startSession(roomCode: string, nickname: string, serverUrl: string): void {
  const phase = useRoom.getState().phase;
  const live = phase === 'joined' || phase === 'connecting' || phase === 'reconnecting';
  if (conn && conn.roomCode === roomCode && conn.serverUrl === serverUrl && live) return;
  conn?.close(true);
  set({ serverUrl });
  mount();
  conn = connect(roomCode, nickname, serverUrl);
}

function endSession(notifyBackground: boolean): void {
  conn?.close(true);
  conn = null;
  if (notifyBackground) void sendToBackground({ type: 'WP_SESSION_CLEAR' }, emptySchema);
  const { collapsed, nickname, serverUrl } = useRoom.getState();
  set({ ...initialView, collapsed, nickname, serverUrl });
  unmount();
}

function setCollapsed(collapsed: boolean): void {
  set({ collapsed, unread: collapsed ? useRoom.getState().unread : 0 });
  void chrome.storage.local.set({ [COLLAPSED_KEY]: collapsed }).catch(() => undefined);
}

const actions: SidebarActions = {
  join: (code, nickname) => startSession(code, nickname, useRoom.getState().serverUrl),
  dismissPrompt: () => endSession(false),
  leave: () => endSession(true),
  sendChat: (text) => conn?.emitIfJoined((s) => s.emit('chat:send', { text })),
  sendReaction: (emoji: ReactionEmoji) => conn?.emitIfJoined((s) => s.emit('reaction:send', { emoji })),
  seekTo: (seconds) => conn?.seekLocal(seconds),
  loadHere: () => conn?.loadHere(),
  goToParty: (url) => {
    const next = new URL(url);
    if (conn) next.hash = wpHash(conn.roomCode, conn.serverUrl);
    location.assign(next.href);
  },
  resumeAutoplay: () => {
    set({ autoplayBlocked: false });
    conn?.controller.resumeAfterGesture();
  },
  retryScan: () => conn?.rescan(),
  setCollapsed,
  dismissNotice: () => set({ notice: null }),
};

// ---------- background -> content messages ----------

function onBackgroundMessage(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (reply: unknown) => void,
): false {
  if (sender.id !== chrome.runtime.id) return false;
  const parsed = internalMessageSchema.safeParse(raw);
  if (!parsed.success) {
    sendResponse(fail('INVALID_PAYLOAD', 'Unknown message'));
    return false;
  }
  const msg: InternalMessage = parsed.data;
  switch (msg.type) {
    case 'WP_SESSION_SET':
      startSession(msg.roomCode, msg.nickname, msg.serverUrl); // "join now"; a no-op when already in that room
      sendResponse(ok({}));
      break;
    case 'WP_SESSION_CLEAR':
      endSession(false);
      sendResponse(ok({}));
      break;
    case 'WP_SIDEBAR_TOGGLE': {
      if (!host) {
        set({ phase: 'prompt', collapsed: false });
        mount();
      } else {
        setCollapsed(!useRoom.getState().collapsed);
      }
      sendResponse(ok({}));
      break;
    }
    default:
      sendResponse(fail('INVALID_PAYLOAD', 'Not a content-script message'));
  }
  return false;
}

// ---------- boot ----------

async function boot(): Promise<void> {
  chrome.runtime.onMessage.addListener(onBackgroundMessage);
  if (pageProvider() === 'netflix') void sendToBackground({ type: 'WP_MAIN_BRIDGE' }, emptySchema);
  const [collapsedRaw, nicknameRaw, serverUrl] = await Promise.all([
    readLocal(COLLAPSED_KEY),
    readLocal(NICKNAME_KEY),
    lastServerUrl(),
  ]);
  set({ collapsed: collapsedRaw === true, nickname: typeof nicknameRaw === 'string' ? nicknameRaw : '', serverUrl });

  const res = await sendToBackground({ type: 'WP_SESSION_GET' }, sessionSchema.nullable());
  if (res.ok && res.data) {
    startSession(res.data.roomCode, res.data.nickname, res.data.serverUrl);
    return;
  }
  // Fallback #wp=CODE[@host]: prompt, never auto-join (a link from anyone must not silently seat the user). The
  // prompt shows the server host, since the link chooses it.
  const m = HASH_RE.exec(location.hash);
  if (m?.[1]) {
    const linked = m[2] === undefined ? null : serverUrlSchema.safeParse(`https://${m[2]}`);
    set({ phase: 'prompt', promptCode: m[1], collapsed: false, ...(linked?.success ? { serverUrl: linked.data } : {}) });
    mount();
  }
}

if (!globalThis.__wpLoaded) {
  globalThis.__wpLoaded = true;
  void boot();
}
