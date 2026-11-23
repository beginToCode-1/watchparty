'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { pingExtension } from '@/lib/extension';
import { act } from '@/lib/socket';
import { useRoom, type Connection } from '@/store/room';

const CONNECTION: Record<Connection, { label: string; dot: string }> = {
  idle: { label: 'Offline', dot: 'bg-zinc-500' },
  connecting: { label: 'Connecting', dot: 'bg-signal-warn motion-safe:animate-pulse' },
  connected: { label: 'Live', dot: 'bg-signal-live' },
  reconnecting: { label: 'Reconnecting', dot: 'bg-signal-warn motion-safe:animate-pulse' },
  error: { label: 'Server unreachable', dot: 'bg-signal-err' },
};

export function RoomHeader({ code }: { code: string }) {
  const connection = useRoom((s) => s.connection);
  const isHost = useRoom((s) => !!s.session && s.session.userId === s.hostId);
  const hostOnly = useRoom((s) => s.hostOnlyControl);
  const count = useRoom((s) => s.participants.length);
  const [copied, setCopied] = useState(false);
  const [extension, setExtension] = useState(false);
  const fallback = useRef<HTMLInputElement>(null);
  const [showFallback, setShowFallback] = useState(false);
  const c = CONNECTION[connection];

  useEffect(() => {
    void pingExtension().then((r) => setExtension(r !== null));
  }, []);

  const invite = typeof window === 'undefined' ? '' : `${window.location.origin}/room/${code}`;

  function copy() {
    navigator.clipboard.writeText(invite).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_500);
      },
      () => {
        // Clipboard blocked (permissions / insecure origin): show the link selected for manual copy.
        setShowFallback(true);
        requestAnimationFrame(() => fallback.current?.select());
      },
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-3">
        <Link href="/" className="pressable rounded-lg px-1 text-sm text-zinc-400 hover:text-zinc-100" aria-label="Leave room">
          ← Leave
        </Link>
        <h1 className="font-mono text-2xl font-bold tracking-[0.2em]" aria-label={`Room ${code.split('').join(' ')}`}>
          {code}
        </h1>
        <button type="button" className="btn-ghost py-1.5" onClick={copy}>
          {copied ? 'Copied ✓' : 'Copy invite'}
        </button>
        {showFallback && (
          <input
            ref={fallback}
            readOnly
            value={invite}
            onBlur={() => setShowFallback(false)}
            className="field w-64 py-1.5 text-xs"
            aria-label="Invite link"
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="badge bg-white/[0.06] text-zinc-300" role="status">
          <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} aria-hidden />
          {c.label}
        </span>
        <span className="badge bg-white/[0.06] text-zinc-300">
          {count} watching
        </span>
        {isHost && <span className="badge bg-screen/15 text-screen">👑 You&apos;re the host</span>}
        {extension && <span className="badge bg-sky-400/15 text-sky-300">🧩 Extension connected</span>}
        {isHost ? (
          <label className="badge cursor-pointer bg-white/[0.06] text-zinc-300">
            <input
              type="checkbox"
              checked={hostOnly}
              onChange={(e) => void act('room:settings', { hostOnlyControl: e.target.checked })}
              className="accent-screen"
            />
            Only I control playback
          </label>
        ) : (
          hostOnly && <span className="badge bg-white/[0.06] text-zinc-400">Host controls playback</span>
        )}
      </div>
    </div>
  );
}
