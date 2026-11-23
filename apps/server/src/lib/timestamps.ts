import { CHAT_TIMESTAMPS_MAX, MAX_POSITION_S, TIMESTAMP_TAG } from '@watchparty/shared-types';

/** docs/SYNC_PROTOCOL.md §9; duplicates kept, in order. */
export function extractTimestamps(text: string): number[] {
  const out: number[] = [];
  // matchAll iterates a clone of the global regex: the shared constant's lastIndex is never moved (and never exec()'d here).
  for (const m of text.matchAll(TIMESTAMP_TAG)) {
    const [, a, b, c] = m;
    const seconds = c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c);
    if (seconds <= MAX_POSITION_S) out.push(seconds);
    if (out.length >= CHAT_TIMESTAMPS_MAX) break;
  }
  return out;
}
