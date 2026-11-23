import type { MediaInfo } from '@watchparty/shared-types';

const MODE_TEXT: Record<MediaInfo['mode'], { label: string; cls: string }> = {
  A: { label: 'Plays in app', cls: 'bg-signal-live/15 text-signal-live' },
  B: { label: 'Needs extension', cls: 'bg-sky-400/15 text-sky-300' },
  C: { label: 'Screen share', cls: 'bg-violet-400/15 text-violet-300' },
};

const KIND_TEXT: Record<MediaInfo['kind'], string> = {
  hls: 'HLS stream',
  file: 'Video file',
  youtube: 'YouTube',
  local: 'Local file',
  drm: 'Streaming service',
  unknown: 'Web page',
};

export function ModeBadge({ info }: { info: Pick<MediaInfo, 'kind' | 'mode'> }) {
  const m = MODE_TEXT[info.mode];
  return (
    <span className={`badge ${m.cls}`}>
      <span aria-hidden>●</span>
      {KIND_TEXT[info.kind]} · {m.label}
    </span>
  );
}

export function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
    />
  );
}
