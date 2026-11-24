'use client';

import type { ReactNode } from 'react';
import { MAX_POSITION_S, TIMESTAMP_TAG, type ChatMessage as Msg } from '@watchparty/shared-types';
import { formatTimecode, parseTimecode } from '@watchparty/sync-engine/timecode';
import { act } from '@/lib/socket';

// The k-th tag maps to timestamps[k] (SYNC_PROTOCOL §9); the server drops tags past MAX_POSITION_S, so skip those too.
function renderText(text: string, timestamps: number[], canSeek: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TIMESTAMP_TAG)) {
    if ((parseTimecode(m[0].slice(1)) ?? 0) > MAX_POSITION_S) continue;
    const at = m.index;
    const t = timestamps[k];
    if (t === undefined) break;
    k++;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <button
        key={`t${at}`}
        type="button"
        disabled={!canSeek}
        title={canSeek ? `Jump everyone to ${formatTimecode(t)}` : 'Only the host can seek'}
        onClick={() => void act('player:seek', { position: t })}
        className="pressable mx-0.5 inline-flex items-center rounded-md bg-screen/15 px-1.5 py-px font-mono text-[13px] font-semibold text-screen hover:bg-screen/25"
      >
        ▶ {formatTimecode(t)}
      </button>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function ChatMessage({ msg, mine, canSeek }: { msg: Msg; mine: boolean; canSeek: boolean }) {
  const time = new Date(msg.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <li className="group px-3 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className={`truncate text-[13px] font-semibold ${mine ? 'text-screen' : 'text-zinc-200'}`}>{msg.nickname}</span>
        <span className="text-[11px] tabular-nums text-zinc-600">{time}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-[14px] leading-snug text-zinc-300">
        {renderText(msg.text, msg.timestamps, canSeek)}
      </p>
    </li>
  );
}
