'use client';

import { useRef, useState } from 'react';
import { getMesh, mediaError } from '@/lib/webrtc';
import { safeHttpUrl } from '@/lib/util';
import { useRoom } from '@/store/room';
import { ExtensionHandoff } from './ExtensionHandoff';
import { Spinner } from './ModeBadge';
import { PipButton, StreamVideo } from './StreamVideo';

/** Mode C: one participant shares a tab over WebRTC; everyone else watches that stream. */
export function ScreenShareView({ mediaUrl }: { mediaUrl: string }) {
  const participants = useRoom((s) => s.participants);
  const me = useRoom((s) => s.session?.userId);
  const localScreen = useRoom((s) => s.call.localScreen);
  const remote = useRoom((s) => s.call.remote);
  const noAudio = useRoom((s) => s.call.screenNoAudio);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const href = safeHttpUrl(mediaUrl);

  const sharer = participants.find((p) => p.media.screen && p.id !== me) ?? null;
  const remoteStream = sharer ? (remote[sharer.id]?.screen ?? null) : null;

  async function share() {
    const mesh = getMesh();
    if (!mesh) return;
    setBusy(true);
    setError(null);
    try {
      await mesh.startScreenShare();
    } catch (err: unknown) {
      setError(mediaError(err));
    } finally {
      setBusy(false);
    }
  }

  if (localScreen) {
    return (
      <div className="relative h-full w-full bg-black">
        <StreamVideo stream={localScreen} label="Your shared screen" className="h-full w-full object-contain" videoRef={videoRef} />
        <div className="material absolute inset-x-3 bottom-3 z-20 flex flex-wrap items-center gap-3 rounded-2xl px-4 py-2.5 text-sm">
          <span className="inline-flex items-center gap-2 font-medium">
            <span className="h-2 w-2 rounded-full bg-signal-err motion-safe:animate-pulse" aria-hidden /> You&apos;re sharing
          </span>
          {noAudio && (
            <span className="text-signal-warn">No audio captured: share a Chrome tab and tick “Share tab audio”.</span>
          )}
          <button type="button" className="btn-danger ml-auto py-1.5" onClick={() => getMesh()?.stopScreenShare()}>
            Stop sharing
          </button>
        </div>
      </div>
    );
  }

  if (sharer) {
    return (
      <div className="relative h-full w-full bg-black">
        {remoteStream ? (
          <>
            <StreamVideo
              stream={remoteStream}
              label={`${sharer.nickname}'s shared screen`}
              className="h-full w-full object-contain"
              videoRef={videoRef}
            />
            <PipButton videoRef={videoRef} />
          </>
        ) : (
          <div className="grid h-full place-items-center text-sm text-zinc-400">
            <span className="inline-flex items-center gap-2">
              <Spinner /> Connecting to {sharer.nickname}&apos;s screen…
            </span>
          </div>
        )}
        <p className="material absolute left-3 top-3 z-10 rounded-full px-3 py-1 text-xs font-medium">
          {sharer.nickname} is sharing
        </p>
      </div>
    );
  }

  return (
    <div className="grid h-full place-items-center overflow-y-auto p-6 text-center">
      <div className="max-w-md">
        <p className="text-4xl" aria-hidden>
          🖥️
        </p>
        <h3 className="mt-3 text-xl font-semibold tracking-title">Share a tab to watch this together</h3>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          This page can&apos;t be embedded. Open it in another tab, then share that tab — with its sound — and everyone here
          sees it live.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {href && (
            <a className="btn-ghost" href={href} target="_blank" rel="noopener noreferrer nofollow">
              1. Open the page ↗
            </a>
          )}
          <button type="button" className="btn-primary" onClick={() => void share()} disabled={busy}>
            {busy ? <Spinner /> : null} 2. Share a tab
          </button>
        </div>
        <div className="mt-3 flex justify-center">
          <ExtensionHandoff mediaUrl={mediaUrl} compact />
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-signal-err">
            {error}
          </p>
        )}
        <p className="mt-4 text-xs text-zinc-500">Waiting for someone to share…</p>
      </div>
    </div>
  );
}
