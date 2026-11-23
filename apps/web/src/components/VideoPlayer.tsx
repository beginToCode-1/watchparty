'use client';

import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import type { HlsConfig } from 'hls.js';
import type { MediaKind } from '@watchparty/shared-types';
import { HTMLVideoAdapter } from '@watchparty/sync-engine';
import { attachSync } from '@/lib/socket';
import { PipButton } from './StreamVideo';

// docs/WEBRTC_AND_MEDIA.md §3.1. maxLiveSyncPlaybackRate 1 is required: SyncController owns playbackRate.
const retry = (n: number) => ({ maxNumRetry: n, retryDelayMs: 1_000, maxRetryDelayMs: 8_000, backoff: 'exponential' as const });
const noDelay = (n: number) => ({ maxNumRetry: n, retryDelayMs: 0, maxRetryDelayMs: 0 });
const HLS_CONFIG: Partial<HlsConfig> = {
  backBufferLength: 30,
  maxMaxBufferLength: 120,
  maxBufferHole: 0.5,
  nudgeMaxRetry: 5,
  startFragPrefetch: true,
  capLevelToPlayerSize: true,
  abrEwmaDefaultEstimate: 5_000_000,
  liveMaxLatencyDurationCount: 10,
  maxLiveSyncPlaybackRate: 1,
  liveDurationInfinity: true,
  manifestLoadPolicy: {
    default: { maxTimeToFirstByteMs: 8_000, maxLoadTimeMs: 15_000, timeoutRetry: noDelay(2), errorRetry: retry(3) },
  },
  playlistLoadPolicy: {
    default: { maxTimeToFirstByteMs: 8_000, maxLoadTimeMs: 15_000, timeoutRetry: noDelay(2), errorRetry: retry(4) },
  },
  fragLoadPolicy: {
    default: { maxTimeToFirstByteMs: 8_000, maxLoadTimeMs: 20_000, timeoutRetry: noDelay(4), errorRetry: retry(6) },
  },
};

const MEDIA_ESCALATE_MS = 3_000;
const REBUILD_WINDOW_MS = 60_000;

const FALLBACK_HINT = 'If it keeps failing, open the page in a tab and use screen share instead.';

/**
 * hls.js with the §3.3 recovery ladder: network → hls.js's own load-policy retries, fatal = give up; media →
 * recoverMediaError, then swapAudioCodec, then rebuild; anything else → rebuild (once per minute).
 */
function attachHls(HlsCtor: typeof Hls, video: HTMLVideoElement, src: string, onFail: (msg: string) => void): () => void {
  let hls: Hls | null = null;
  let mediaStep = 0;
  let lastMediaErr = 0;
  let lastRebuild = 0;
  let dead = false;

  const fail = (msg: string) => {
    dead = true;
    hls?.destroy();
    hls = null;
    onFail(msg);
  };

  const build = (startPosition: number) => {
    hls = new HlsCtor({ ...HLS_CONFIG, startPosition });
    const h = hls;
    h.on(HlsCtor.Events.ERROR, (_evt, data) => {
      if (!data.fatal || dead || h !== hls) return;
      const now = performance.now();
      if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR) {
        // Fatal = the load policies' retries are exhausted already.
        return fail(
          data.details === HlsCtor.ErrorDetails.MANIFEST_LOAD_ERROR
            ? `Could not load the stream (the server may block other sites). ${FALLBACK_HINT}`
            : `The stream keeps dropping. ${FALLBACK_HINT}`,
        );
      }
      if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) {
        mediaStep = now - lastMediaErr < MEDIA_ESCALATE_MS ? mediaStep + 1 : 1;
        lastMediaErr = now;
        if (mediaStep === 1) return h.recoverMediaError();
        if (mediaStep === 2) {
          h.swapAudioCodec();
          return h.recoverMediaError();
        }
      }
      if (lastRebuild > 0 && now - lastRebuild < REBUILD_WINDOW_MS) return fail(`This stream can't be decoded here. ${FALLBACK_HINT}`);
      lastRebuild = now;
      mediaStep = 0;
      const pos = video.currentTime;
      h.destroy();
      build(pos);
    });
    h.loadSource(src);
    h.attachMedia(video);
  };

  build(-1);
  return () => {
    dead = true;
    hls?.destroy();
    hls = null;
  };
}

export function VideoPlayer({ src, kind }: { src: string; kind: MediaKind }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    setError(null);
    let cancelled = false;
    let detachHls: (() => void) | null = null;
    const adapter = new HTMLVideoAdapter(video);
    const detachSync = attachSync(adapter);
    const onError = () => {
      const code = video.error?.code;
      if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
        setError(`This browser can't play this file's container or codec. ${FALLBACK_HINT}`);
      } else if (code === MediaError.MEDIA_ERR_NETWORK) {
        setError('The video stopped downloading. Check the link or your connection.');
      } else if (code === MediaError.MEDIA_ERR_DECODE) {
        setError(`The video could not be decoded. ${FALLBACK_HINT}`);
      }
    };
    video.addEventListener('error', onError);

    if (kind === 'hls') {
      import('hls.js')
        .then(({ default: HlsCtor }) => {
          if (cancelled) return;
          if (HlsCtor.isSupported()) detachHls = attachHls(HlsCtor, video, src, setError);
          else if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = src;
          else setError('HLS is not supported in this browser.');
        })
        .catch(() => setError('Could not load the HLS player.'));
    } else {
      video.src = src;
    }

    return () => {
      cancelled = true;
      video.removeEventListener('error', onError);
      detachSync();
      adapter.destroy();
      detachHls?.();
      if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => undefined);
      video.removeAttribute('src');
      video.load();
    };
  }, [src, kind]);

  return (
    <div className="relative h-full w-full bg-black">
      <video ref={ref} playsInline controls preload="auto" className="h-full w-full bg-black object-contain" />
      <PipButton videoRef={ref} />
      {error && (
        <div role="alert" className="absolute inset-x-4 bottom-16 z-20 rounded-2xl bg-signal-err/15 p-4 text-sm text-red-100 backdrop-blur">
          {error}
        </div>
      )}
    </div>
  );
}
