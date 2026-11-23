const TIMECODE = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/;

/** Parses `m:ss`, `mm:ss` or `h:mm:ss` into seconds; anything else returns null. */
export function parseTimecode(s: string): number | null {
  const m = TIMECODE.exec(s.trim());
  if (!m) return null;
  const [, a = '0', b = '0', c] = m;
  return c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c);
}

/** `m:ss` below one hour, `h:mm:ss` above. Negative or non-finite input formats as `0:00`. */
export function formatTimecode(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
