'use client';

import { useRoom } from '@/store/room';
import { StreamVideo } from './StreamVideo';

/** Voice/camera bubbles for everyone with media on. */
export function CallGrid() {
  const participants = useRoom((s) => s.participants);
  const me = useRoom((s) => s.session?.userId);
  const call = useRoom((s) => s.call);
  const active = participants.filter((p) => (p.id === me ? call.mic || call.cam : p.media.audio || p.media.video));
  if (active.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-3" aria-label="Call">
      {active.map((p) => {
        const mine = p.id === me;
        const stream = mine ? (call.cam ? call.localCam : null) : p.media.video ? (call.remote[p.id]?.cam ?? null) : null;
        const speaking = call.speaking[p.id] === true;
        const micOn = mine ? call.mic : p.media.audio;
        return (
          <li key={p.id} className="animate-materialize flex w-20 flex-col items-center gap-1.5">
            <div
              className={`relative h-20 w-20 overflow-hidden rounded-full bg-ink-700 transition-[box-shadow] duration-150 ${
                speaking ? 'shadow-[0_0_0_3px_theme(colors.signal.live),0_0_24px_rgba(61,220,132,0.45)]' : 'shadow-[0_0_0_1px_rgba(255,255,255,0.08)]'
              }`}
            >
              {stream ? (
                <StreamVideo stream={stream} mirrored={mine} label={`${p.nickname}'s camera`} className="h-full w-full object-cover" />
              ) : (
                <span className="grid h-full w-full place-items-center text-2xl font-semibold uppercase text-zinc-300" aria-hidden>
                  {p.nickname.slice(0, 1)}
                </span>
              )}
              {!micOn && (
                <span className="absolute bottom-1 right-1 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-[10px]" aria-label="Muted">
                  🔇
                </span>
              )}
            </div>
            <span className="w-full truncate text-center text-[11px] text-zinc-400">{mine ? 'You' : p.nickname}</span>
          </li>
        );
      })}
    </ul>
  );
}
