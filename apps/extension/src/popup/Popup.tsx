import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  nicknameSchema,
  roomCodeSchema,
  serverUrlSchema,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@watchparty/shared-types';
import contentScript from '../content/index.tsx?script';
import {
  ALL_SITES,
  NICKNAME_KEY,
  emptySchema,
  lastServerUrl,
  readLocal,
  sendToBackground,
  sendToTab,
  sessionSchema,
  stripHash,
  webUrlFor,
  type Session,
} from '../bridge';
import { CodeNameFields, fieldClass, primaryButton, secondaryButton } from '../content/sidebar/JoinPrompt';

const CREATE_TIMEOUT_MS = 8000;

/** Server field -> origin; a bare host (abc.trycloudflare.com) means https. */
function parseServer(raw: string): string | null {
  const t = raw.trim();
  const parsed = serverUrlSchema.safeParse(/^https?:\/\//i.test(t) ? t : `https://${t}`);
  return parsed.success ? parsed.data : null;
}

type Health = 'checking' | 'up' | 'down';

/**
 * Creates a room for `mediaUrl` on a short-lived socket and leaves it again. The room survives empty (contract D6)
 * and the content script's join makes this tab's user the host (first joiner of an empty room).
 */
function createRoom(serverUrl: string, nickname: string, mediaUrl: string): Promise<string> {
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(serverUrl, {
    transports: ['websocket'],
    reconnection: false,
    timeout: CREATE_TIMEOUT_MS,
  });
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The server did not answer')), CREATE_TIMEOUT_MS);
    socket.on('connect_error', () => {
      clearTimeout(timer);
      reject(new Error('Cannot reach the WatchParty server'));
    });
    socket.emit('room:create', { nickname, mediaUrl }, (res) => {
      clearTimeout(timer);
      if (res.ok) resolve(res.data.roomCode);
      else reject(new Error(res.error.message));
    });
  }).finally(() => socket.disconnect());
}

function Dot({ health }: { health: Health }) {
  const color = health === 'up' ? 'bg-[#30d158]' : health === 'down' ? 'bg-[#ff453a]' : 'bg-neutral-400';
  const label = health === 'up' ? 'Server online' : health === 'down' ? 'Server offline' : 'Checking server…';
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-neutral-500 dark:text-neutral-400" role="status">
      <span aria-hidden className={`h-2 w-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

export function Popup() {
  const [health, setHealth] = useState<Health>('checking');
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [allSites, setAllSites] = useState(false);
  const [mode, setMode] = useState<'join' | 'create'>('join');
  const [code, setCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [server, setServer] = useState('');
  const [hasScript, setHasScript] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [res, [active], granted] = await Promise.all([
      sendToBackground({ type: 'WP_SESSION_GET' }, sessionSchema.nullable()),
      chrome.tabs.query({ active: true, currentWindow: true }),
      chrome.permissions.contains({ origins: ALL_SITES }),
    ]);
    const s = res.ok ? res.data : null;
    if (s && s.tabId !== null && s.tabId === active?.id) {
      // Our content script answers WP_SESSION_GET with INVALID_PAYLOAD; TAB_ERROR means nothing is listening.
      const probe = await sendToTab(s.tabId, { type: 'WP_SESSION_GET' }, emptySchema);
      setHasScript(probe.ok || probe.error.code !== 'TAB_ERROR');
    }
    setSession(s);
    setTab(active ?? null);
    setAllSites(granted);
  }, []);

  useEffect(() => {
    void refresh();
    void readLocal(NICKNAME_KEY).then((n) => {
      if (typeof n === 'string') setNickname(n);
    });
    void lastServerUrl().then((u) => setServer((cur) => cur || u));
  }, [refresh]);

  const serverUrl = parseServer(server);
  const healthUrl = session?.serverUrl ?? serverUrl;
  useEffect(() => {
    if (!healthUrl) return setHealth('down');
    let stale = false; // the field changed since: ignore this answer
    setHealth('checking');
    fetch(`${healthUrl}/healthz`, { signal: AbortSignal.timeout(3000) }).then(
      (r) => !stale && setHealth(r.ok ? 'up' : 'down'),
      () => !stale && setHealth('down'),
    );
    return () => {
      stale = true;
    };
  }, [healthUrl]);

  const tabUrl = tab?.url ? stripHash(tab.url) : null;
  const tabId = tab?.id;

  /** Points the session at the active tab and makes sure our content script runs there. */
  const syncTab = async (roomCode: string, name: string, server: string): Promise<void> => {
    if (tabId === undefined || !tabUrl) throw new Error('Open the page with the video first.');
    const res = await sendToBackground(
      { type: 'WP_SESSION_SET', roomCode, nickname: name, mediaUrl: tabUrl, serverUrl: server, tabId },
      sessionSchema,
    );
    if (!res.ok) throw new Error(res.error.message);
    try {
      // Static script on provider sites; activeTab grant (this popup click) everywhere else. Guarded against doubles.
      await chrome.scripting.executeScript({ target: { tabId }, files: [contentScript] });
    } catch {
      throw new Error('This page does not allow extensions to run.');
    }
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = nickname.trim();
    void run(async () => {
      if (!tabUrl) throw new Error('Open the page with the video first.');
      if (!serverUrl) throw new Error('Enter the server address your host shared.');
      const roomCode = mode === 'join' ? code : await createRoom(serverUrl, name, tabUrl);
      await syncTab(roomCode, name, serverUrl);
    });
  };

  const nameOk = nicknameSchema.safeParse(nickname).success;
  const canSubmit =
    !busy && nameOk && tabUrl !== null && serverUrl !== null && (mode === 'create' || roomCodeSchema.safeParse(code).success);
  const sessionHere = session !== null && session.tabId === tabId;
  // Handed-off tab without our content script (non-provider page, no all-sites grant, or an orphaned script).
  const needsJoin = sessionHere && (!hasScript || (!allSites && session.provider === null));

  return (
    <main className="space-y-4 p-4 text-neutral-900 dark:text-neutral-100">
      <header className="flex items-center justify-between">
        <h1 className="text-[17px] font-semibold tracking-[-0.01em]">WatchParty</h1>
        <Dot health={health} />
      </header>

      {session ? (
        <section className="rounded-2xl bg-white p-4 shadow-sm dark:bg-white/[0.07]" aria-label="Current party">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-400">
            {sessionHere ? 'Party on this tab' : 'Party in another tab'}
          </p>
          <p className="mt-1 font-mono text-[28px] font-semibold leading-none tracking-[0.14em]">{session.roomCode}</p>
          <p className="mt-1 text-[13px] text-neutral-500 dark:text-neutral-400">as {session.nickname}</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {needsJoin ? (
              <button
                type="button"
                disabled={busy}
                className={`${primaryButton} col-span-2`}
                onClick={() => void run(() => syncTab(session.roomCode, session.nickname, session.serverUrl))}
              >
                Join on this tab
              </button>
            ) : null}
            {sessionHere ? (
              <button
                type="button"
                disabled={!hasScript}
                className={secondaryButton}
                onClick={() => {
                  if (session.tabId !== null) void sendToTab(session.tabId, { type: 'WP_SIDEBAR_TOGGLE' }, emptySchema);
                }}
              >
                Toggle sidebar
              </button>
            ) : (
              <button
                type="button"
                className={secondaryButton}
                onClick={() => {
                  if (session.tabId === null) return;
                  void chrome.tabs.update(session.tabId, { active: true }).then((t) => {
                    if (t) void chrome.windows.update(t.windowId, { focused: true });
                  });
                }}
              >
                Go to tab
              </button>
            )}
            <a href={`${webUrlFor(session.serverUrl)}/room/${session.roomCode}`} target="_blank" rel="noreferrer" className={`${secondaryButton} flex items-center justify-center`}>
              Open web app
            </a>
            {!sessionHere && tabUrl && (
              <button
                type="button"
                disabled={busy}
                className={`${primaryButton} col-span-2`}
                onClick={() => void run(() => syncTab(session.roomCode, session.nickname, session.serverUrl))}
              >
                Sync this tab instead
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              className={`${secondaryButton} col-span-2 text-[#ff3b30] dark:text-[#ff453a]`}
              onClick={() =>
                void run(async () => {
                  await sendToBackground({ type: 'WP_SESSION_CLEAR' }, emptySchema);
                })
              }
            >
              Leave party
            </button>
          </div>
        </section>
      ) : (
        <form onSubmit={submit} className="space-y-3 rounded-2xl bg-white p-4 shadow-sm dark:bg-white/[0.07]">
          <div role="tablist" aria-label="Join or create" className="flex rounded-[10px] bg-black/[0.06] p-0.5 dark:bg-white/10">
            {(['join', 'create'] as const).map((m) => (
              <button
                key={m}
                role="tab"
                type="button"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={`h-7 flex-1 rounded-[8px] text-[13px] font-medium transition-colors duration-200 ${
                  mode === m ? 'bg-white shadow-sm dark:bg-white/20' : 'text-neutral-500 dark:text-neutral-400'
                }`}
              >
                {m === 'join' ? 'Join room' : 'New room'}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-neutral-500 dark:text-neutral-400">Server</span>
            <input
              value={server}
              onChange={(e) => setServer(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://abc-def.trycloudflare.com"
              aria-invalid={serverUrl === null}
              className={fieldClass}
            />
          </label>
          <CodeNameFields
            code={mode === 'join' ? code : undefined}
            onCode={setCode}
            nickname={nickname}
            onNickname={setNickname}
          />
          <p className="truncate text-[12px] text-neutral-500 dark:text-neutral-400" title={tabUrl ?? undefined}>
            {tabUrl ? `Syncs the video on ${new URL(tabUrl).hostname}` : 'Open the page with the video first.'}
          </p>
          <button type="submit" disabled={!canSubmit} className={primaryButton}>
            {busy ? 'Working…' : mode === 'join' ? 'Join and sync this tab' : 'Create room for this tab'}
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="rounded-xl bg-[#ff3b30]/10 px-3 py-2 text-[13px] text-[#d70015] dark:text-[#ff6961]">
          {error}
        </p>
      )}

      <footer className="flex items-center justify-between text-[12px]">
        {allSites ? (
          <span className="text-neutral-500 dark:text-neutral-400">Enabled on all sites</span>
        ) : (
          <button
            type="button"
            className="font-medium text-[#007aff] dark:text-[#0a84ff]"
            onClick={() =>
              void chrome.permissions.request({ origins: ALL_SITES }).then((granted) => {
                setAllSites(granted);
              })
            }
          >
            Enable on all sites
          </button>
        )}
        <a href={webUrlFor(healthUrl ?? import.meta.env.VITE_SERVER_URL)} target="_blank" rel="noreferrer" className="font-medium text-[#007aff] dark:text-[#0a84ff]">
          Open WatchParty
        </a>
      </footer>
    </main>
  );
}
