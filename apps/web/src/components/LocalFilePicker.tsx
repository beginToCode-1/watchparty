'use client';

import { useEffect, useState } from 'react';
import { useRoom } from '@/store/room';
import { VideoPlayer } from './VideoPlayer';

/**
 * `local:<name>` rooms: each viewer plays their own copy; only the time is synced.
 * The object URL never leaves this browser and is revoked when the file or the room media changes.
 */
export function LocalFilePicker({ expectedName }: { expectedName: string }) {
  const file = useRoom((s) => s.localFile);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [file]);

  if (file && url) {
    return (
      <div className="relative h-full w-full">
        <VideoPlayer key={url} src={url} kind="local" />
        {file.name !== expectedName && (
          <p className="material absolute left-3 top-3 z-20 max-w-[70%] rounded-xl px-3 py-1.5 text-xs text-signal-warn">
            Your file is “{file.name}”, the room is watching “{expectedName}”. Times sync, but make sure it&apos;s the same video.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-sm">
        <p className="text-4xl" aria-hidden>
          🎞️
        </p>
        <h3 className="mt-3 text-lg font-semibold tracking-title">Pick your copy of the file</h3>
        <p className="mt-1 break-words text-sm text-zinc-400">
          The room is watching <span className="font-medium text-zinc-200">{expectedName}</span>. Everyone plays their own
          copy; nothing is uploaded.
        </p>
        <label className="btn-primary mt-5 cursor-pointer">
          Choose file
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
      </div>
    </div>
  );
}
