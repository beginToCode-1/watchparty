'use client';

import { useEffect, useRef, useState } from 'react';
import { attachSync } from '@/lib/socket';
import { YouTubeAdapter, loadYouTubeApi } from '@/lib/youtube-adapter';

const YT_ERRORS: Record<number, string> = {
  2: 'YouTube rejected the video id.',
  5: 'YouTube could not play this video in the browser.',
  100: 'This video was removed or is private.',
  101: 'Embedding is disabled by the owner of this video.',
  150: 'Embedding is disabled by the owner of this video.',
};

export function YouTubePlayer({ videoId }: { videoId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    setError(null);
    let cancelled = false;
    let player: YT.Player | null = null;
    let adapter: YouTubeAdapter | null = null;
    let detach: (() => void) | null = null;

    loadYouTubeApi()
      .then(() => {
        if (cancelled) return;
        // YT replaces this node with its iframe, so React must not own it.
        const mount = document.createElement('div');
        container.replaceChildren(mount);
        player = new YT.Player(mount, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: window.location.origin },
          events: {
            onReady: () => adapter?.handleReady(),
            onStateChange: (e) => adapter?.handleStateChange(e.data),
            onPlaybackRateChange: () => adapter?.handleRateChange(),
            onError: (e) => {
              adapter?.handleError();
              setError(YT_ERRORS[e.data] ?? `YouTube error ${e.data}.`);
            },
          },
        });
        adapter = new YouTubeAdapter(player);
        detach = attachSync(adapter);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load YouTube.'));

    return () => {
      cancelled = true;
      detach?.();
      adapter?.destroy();
      player?.destroy();
      container.replaceChildren();
    };
  }, [videoId]);

  return (
    <div className="relative h-full w-full bg-black">
      <div ref={host} className="h-full w-full [&>iframe]:h-full [&>iframe]:w-full" />
      {error && (
        <div role="alert" className="absolute inset-x-4 bottom-4 rounded-2xl bg-signal-err/15 p-4 text-sm text-red-100 backdrop-blur">
          {error}
        </div>
      )}
    </div>
  );
}
