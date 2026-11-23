'use client';

import { act } from '@/lib/socket';
import { canControl, useRoom } from '@/store/room';
import { ModeBadge } from './ModeBadge';

export function QueuePanel() {
  const queue = useRoom((s) => s.queue);
  const me = useRoom((s) => s.session?.userId);
  const hostId = useRoom((s) => s.hostId);
  const participants = useRoom((s) => s.participants);
  const control = useRoom(canControl);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2.5">
        <p className="text-xs text-zinc-500">{queue.length === 0 ? 'Nothing queued' : `${queue.length} up next`}</p>
        <button
          type="button"
          className="btn-primary py-1.5"
          disabled={!control || queue.length === 0}
          onClick={() => void act('queue:next', {})}
          title={control ? 'Play the next item for everyone' : 'Only the host can change what plays'}
        >
          ▶ Play next
        </button>
      </div>
      <ol className="scroll-thin min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {queue.length === 0 && (
          <li className="px-3 py-8 text-center text-sm text-zinc-500">Paste a link above and press “+ Queue”.</li>
        )}
        {queue.map((item, i) => {
          const adder = participants.find((p) => p.id === item.addedBy)?.nickname ?? 'someone';
          const removable = item.addedBy === me || hostId === me;
          return (
            <li key={item.id} className="animate-materialize flex items-start gap-3 rounded-xl bg-white/[0.03] p-2.5">
              <span className="mt-0.5 w-5 shrink-0 text-right font-mono text-xs tabular-nums text-zinc-500">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-200" title={item.title}>
                  {item.title}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <ModeBadge info={item} />
                  <span className="text-[11px] text-zinc-500">by {item.addedBy === me ? 'you' : adder}</span>
                </div>
              </div>
              {removable && (
                <button
                  type="button"
                  className="pressable grid h-7 w-7 shrink-0 place-items-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
                  aria-label={`Remove ${item.title}`}
                  onClick={() => void act('queue:remove', { id: item.id })}
                >
                  ✕
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
