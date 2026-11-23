'use client';

import type { ReactNode } from 'react';
import { classifyMediaUrl } from '@watchparty/sync-engine/classify';
import { resumeAfterGesture } from '@/lib/socket';
import { safeHttpUrl } from '@/lib/util';
import { useRoom } from '@/store/room';
import { ExtensionHandoff } from './ExtensionHandoff';
import { LocalFilePicker } from './LocalFilePicker';
import { ScreenShareView } from './ScreenShareView';
import { VideoPlayer } from './VideoPlayer';
import { YouTubePlayer } from './YouTubePlayer';

/** Unified cinema player: routes the room's media to the right player by mode and kind. */
export function PlayerHost() {
  const mediaUrl = useRoom((s) => s.state?.mediaUrl ?? null);
  const kind = useRoom((s) => s.state?.kind ?? null);
  const mode = useRoom((s) => s.state?.mode ?? null);
  const autoplayBlocked = useRoom((s) => s.autoplayBlocked);

  if (!mediaUrl || !kind || !mode) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="text-5xl" aria-hidden>
            🍿
          </p>
          <h2 className="mt-3 text-xl font-semibold tracking-title">Paste a link to start</h2>
          <p className="mt-1 text-sm text-zinc-400">YouTube, an .m3u8 or .mp4 link, a streaming service, or a local file.</p>
        </div>
      </div>
    );
  }

  const info = classifyMediaUrl(mediaUrl);
  let player: ReactNode;
  const src = safeHttpUrl(mediaUrl);
  if (mode === 'B') {
    player = <ExtensionHandoff mediaUrl={mediaUrl} provider={info?.provider} />;
  } else if (mode === 'C') {
    player = <ScreenShareView mediaUrl={mediaUrl} />;
  } else if (kind === 'youtube' && info?.youtubeId) {
    player = <YouTubePlayer key={mediaUrl} videoId={info.youtubeId} />;
  } else if (kind === 'local') {
    const name = /^local:(.+)$/.exec(mediaUrl)?.[1] ?? 'a local file';
    player = <LocalFilePicker key={mediaUrl} expectedName={name} />;
  } else if (src) {
    player = <VideoPlayer key={mediaUrl} src={src} kind={kind} />;
  } else {
    player = <p className="grid h-full place-items-center text-sm text-signal-err">This link can&apos;t be played.</p>;
  }

  return (
    <div className="relative h-full w-full">
      {player}
      {autoplayBlocked && mode === 'A' && (
        <button
          type="button"
          onClick={resumeAfterGesture}
          className="absolute inset-0 z-30 grid place-items-center bg-black/55 backdrop-blur-sm motion-reduce:backdrop-blur-none"
        >
          <span className="btn-primary px-6 py-3 text-[15px] shadow-glow">▶ Click to join playback</span>
        </button>
      )}
    </div>
  );
}
