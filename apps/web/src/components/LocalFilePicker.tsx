'use client';

import { useEffect, useRef, useState } from 'react';
import { getMesh } from '@/lib/webrtc';
import { useRoom } from '@/store/room';
import { Spinner } from './ModeBadge';
import { PipButton, StreamVideo } from './StreamVideo';
import { VideoPlayer } from './VideoPlayer';

/**
 * `local:<name>` rooms. Whoever has the file plays it (time synced) and, if nobody else is already doing it,
 * streams it to the room over WebRTC so friends without the file can watch. Anyone can still pick their own copy.
 * The file itself never leaves this browser; the object URL is revoked when the file or the room media changes.
 */
export function LocalFilePicker({ expectedName }: { expectedName: string }) {
  const file = useRoom((s) => s.localFile);
  const me = useRoom((s) => s.session?.userId);
  const participants = useRoom((s) => s.participants);
  const remote = useRoom((s) => s.call.remote);
  const [url, setUrl] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewRef = useRef<HTMLVideoElement>(null);

  const sharer = participants.find((p) => p.media.screen && p.id !== me) ?? null;
  const sharerStream = sharer ? (remote[sharer.id]?.screen ?? null) : null;

  useEffect(() => {
    if (!file) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [file]);

  // Stream my copy once it has frames, unless someone else streams theirs. Lower userId wins a tie, so two people
  // starting at once don't both back off and retry forever.
  const someoneElseSharing = participants.some((p) => p.media.screen && me !== undefined && p.id < me);
  useEffect(() => {
    const video = videoRef.current;
    if (!url || !video || someoneElseSharing) return;
    let shared = false;
    const start = () => {
      shared = getMesh()?.shareVideoElement(video) ?? false;
      setStreaming(shared);
    };
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) start();
    else video.addEventListener('loadeddata', start, { once: true });
    return () => {
      video.removeEventListener('loadeddata', start);
      if (shared) getMesh()?.stopScreenShare();
      setStreaming(false);
    };
  }, [url, someoneElseSharing]);

  if (file && url) {
    return (
      <div className="relative h-full w-full">
        <VideoPlayer key={url} src={url} kind="local" videoRef={videoRef} />
        <div className="absolute left-3 top-3 z-20 flex max-w-[70%] flex-col items-start gap-1.5">
          {streaming && (
            <p className="material inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium">
              <span className="h-2 w-2 rounded-full bg-signal-err motion-safe:animate-pulse" aria-hidden /> Streaming to
              everyone
            </p>
          )}
          {file.name !== expectedName && (
            <p className="material rounded-xl px-3 py-1.5 text-xs text-signal-warn">
              Your file is “{file.name}”, the room is watching “{expectedName}”. Times sync, but make sure it&apos;s the
              same video.
            </p>
          )}
        </div>
      </div>
    );
  }

  const picker = (
    <label className="btn-ghost cursor-pointer">
      {sharer ? 'Play my own copy instead' : 'Choose file'}
      <input
        type="file"
        accept="video/*,.mkv"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) useRoom.setState({ localFile: f });
        }}
      />
    </label>
  );

  if (sharer) {
    return (
      <div className="relative h-full w-full bg-black">
        {sharerStream ? (
          <>
            <StreamVideo
              stream={sharerStream}
              label={`${sharer.nickname}'s video`}
              className="h-full w-full object-contain"
              videoRef={viewRef}
            />
            <PipButton videoRef={viewRef} />
          </>
        ) : (
          <div className="grid h-full place-items-center text-sm text-zinc-400">
            <span className="inline-flex items-center gap-2">
              <Spinner /> Connecting to {sharer.nickname}&apos;s video…
            </span>
          </div>
        )}
        <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
          <p className="material rounded-full px-3 py-1 text-xs font-medium">{sharer.nickname} is streaming</p>
          {picker}
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-sm">
        <p className="text-4xl" aria-hidden>
          🎞️
        </p>
        <h3 className="mt-3 text-lg font-semibold tracking-title">Waiting for the video…</h3>
        <p className="mt-1 break-words text-sm text-zinc-400">
          The room is watching <span className="font-medium text-zinc-200">{expectedName}</span>. It appears here as soon
          as the person who has the file starts it — or pick your own copy.
        </p>
        <div className="mt-5 flex justify-center">{picker}</div>
      </div>
    </div>
  );
}
