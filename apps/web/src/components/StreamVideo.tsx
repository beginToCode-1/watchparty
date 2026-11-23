'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';

/** <video> bound to a MediaStream (srcObject can't be set from JSX). */
export function StreamVideo({
  stream,
  mirrored = false,
  className = '',
  label,
  videoRef,
}: {
  stream: MediaStream;
  mirrored?: boolean;
  className?: string;
  label: string;
  videoRef?: RefObject<HTMLVideoElement | null>;
}) {
  const own = useRef<HTMLVideoElement>(null);
  const ref = videoRef ?? own;
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    v.play().catch(() => {
      // Muted autoplay is always allowed; a rejection means the element was replaced already.
    });
    return () => {
      v.srcObject = null;
    };
  }, [stream, ref]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      aria-label={label}
      className={`${className} ${mirrored ? '-scale-x-100' : ''}`}
    />
  );
}

/** Picture-in-Picture toggle for a native <video>. Hidden where the browser has no PiP. */
export function PipButton({ videoRef }: { videoRef: RefObject<HTMLVideoElement | null> }) {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    setSupported(typeof document !== 'undefined' && document.pictureInPictureEnabled);
    const v = videoRef.current;
    if (!v) return;
    const on = () => setActive(true);
    const off = () => setActive(false);
    v.addEventListener('enterpictureinpicture', on);
    v.addEventListener('leavepictureinpicture', off);
    return () => {
      v.removeEventListener('enterpictureinpicture', on);
      v.removeEventListener('leavepictureinpicture', off);
    };
  }, [videoRef]);

  if (!supported) return null;
  return (
    <button
      type="button"
      className="material pressable absolute right-3 top-3 z-20 rounded-full px-3 py-1.5 text-xs font-semibold tracking-caption"
      aria-pressed={active}
      onClick={() => {
        const v = videoRef.current;
        if (!v) return;
        const p = document.pictureInPictureElement === v ? document.exitPictureInPicture() : v.requestPictureInPicture();
        p.catch((err: unknown) => console.warn('Picture-in-Picture failed', err));
      }}
    >
      {active ? 'Exit PiP' : 'Pop out'}
    </button>
  );
}
