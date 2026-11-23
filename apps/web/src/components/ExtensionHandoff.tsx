'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DrmProvider } from '@watchparty/shared-types';
import { extensionConfigured, extensionLink, handoffToExtension, pingExtension } from '@/lib/extension';
import { leaveRoom } from '@/lib/socket';
import { safeHttpUrl } from '@/lib/util';
import { useRoom } from '@/store/room';
import { Spinner } from './ModeBadge';

const PROVIDER_NAMES: Record<DrmProvider, string> = {
  netflix: 'Netflix',
  primevideo: 'Prime Video',
  amazon: 'Prime Video',
  disneyplus: 'Disney+',
  hulu: 'Hulu',
  max: 'Max',
  hbomax: 'HBO Max',
  appletv: 'Apple TV+',
  peacock: 'Peacock',
  paramountplus: 'Paramount+',
  crunchyroll: 'Crunchyroll',
  moviebox: 'MovieBox',
  hotstar: 'Hotstar',
  jiocinema: 'JioCinema',
};

type Detect = 'checking' | 'found' | 'missing';

/** Mode B: hand the room to the extension, which drives the provider's own player in the viewer's account. */
export function ExtensionHandoff({
  mediaUrl,
  provider,
  compact = false,
}: {
  mediaUrl: string;
  provider?: DrmProvider;
  compact?: boolean;
}) {
  const session = useRoom((s) => s.session);
  const [detect, setDetect] = useState<Detect>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const href = safeHttpUrl(mediaUrl);
  const site = provider ? PROVIDER_NAMES[provider] : href ? new URL(href).hostname.replace(/^www\./, '') : 'the site';

  const check = useCallback(() => {
    setDetect('checking');
    void pingExtension().then((r) => setDetect(r ? 'found' : 'missing'));
  }, []);
  useEffect(check, [check]);

  async function handoff() {
    if (!session || !href) return;
    setBusy(true);
    setError(null);
    try {
      await handoffToExtension({ roomCode: session.roomCode, nickname: session.nickname, mediaUrl: href });
      leaveRoom(true); // the seat moves to the extension; avoids a duplicate participant
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'The extension could not open the tab.');
    } finally {
      setBusy(false);
    }
  }

  const roomLink = href && session ? extensionLink(href, session.roomCode) : null;

  if (compact) {
    return detect === 'found' ? (
      <button type="button" className="btn-ghost" onClick={() => void handoff()} disabled={busy || !session}>
        {busy ? <Spinner /> : '🧩'} Try with the extension
      </button>
    ) : null;
  }

  return (
    <div className="grid h-full place-items-center overflow-y-auto p-6">
      <div className="max-w-md text-center">
        <p className="text-4xl" aria-hidden>
          🔐
        </p>
        <h3 className="mt-3 text-xl font-semibold tracking-title">Watch on {site} together</h3>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          {site} protects its video, so it can&apos;t play inside WatchParty or be screen-shared. Everyone signs in with
          their own account and the WatchParty extension keeps the players in sync.
        </p>

        {detect === 'checking' && (
          <p className="mt-6 inline-flex items-center gap-2 text-sm text-zinc-400">
            <Spinner /> Looking for the extension…
          </p>
        )}

        {detect === 'found' && (
          <div className="mt-6 flex flex-col items-center gap-3">
            <button type="button" className="btn-primary px-6 py-3 text-[15px]" onClick={() => void handoff()} disabled={busy || !session}>
              {busy ? <Spinner /> : null}
              Open {site} with WatchParty
            </button>
            <p className="text-xs text-zinc-500">The party moves to that tab, with chat in a sidebar.</p>
          </div>
        )}

        {detect === 'missing' && (
          <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-left text-sm">
            <p className="font-medium text-zinc-200">Install the WatchParty extension</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-zinc-400">
              <li>
                Build it with <code className="rounded bg-black/40 px-1 font-mono text-xs">pnpm --filter @watchparty/extension build</code>.
              </li>
              <li>
                Open <code className="rounded bg-black/40 px-1 font-mono text-xs">chrome://extensions</code>, turn on Developer
                mode and choose <span className="text-zinc-200">Load unpacked</span> → <code className="font-mono text-xs">apps/extension/dist</code>.
              </li>
              <li>Come back here and check again.</li>
            </ol>
            {!extensionConfigured && (
              <p className="mt-3 text-xs text-signal-warn">
                This site was built without NEXT_PUBLIC_EXTENSION_ID, so it can&apos;t talk to the extension directly. Use
                the room link below instead.
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="btn-ghost" onClick={check}>
                Check again
              </button>
            </div>
          </div>
        )}

        {roomLink && (
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <a className="btn-ghost" href={roomLink} target="_blank" rel="noopener noreferrer nofollow">
              Open {site} with room code ↗
            </a>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                void navigator.clipboard.writeText(roomLink).then(
                  () => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1_500);
                  },
                  () => setError('Copy failed — select the link manually.'),
                );
              }}
            >
              {copied ? 'Copied ✓' : 'Copy extension link'}
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-signal-err">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/** Shown instead of the room after a handoff. */
export function HandedOff({ onRejoin }: { onRejoin: () => void }) {
  return (
    <main className="grid min-h-[70dvh] place-items-center px-4">
      <div className="material-thick animate-materialize max-w-md rounded-3xl p-8 text-center">
        <p className="text-4xl" aria-hidden>
          🧩
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-title">Continuing in the other tab</h1>
        <p className="mt-2 text-sm text-zinc-400">
          The extension joined the party for you in the streaming tab. You can close this one, or come back here.
        </p>
        <button type="button" className="btn-primary mt-6" onClick={onRejoin}>
          Rejoin here
        </button>
      </div>
    </main>
  );
}
