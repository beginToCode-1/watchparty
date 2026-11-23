import { Camera, Mic, Screen } from './icons';
import { useRoom } from './store';

export function Participants() {
  const participants = useRoom((s) => s.participants);
  const me = useRoom((s) => s.userId);
  const buffering = useRoom((s) => s.buffer.userIds);
  const hostOnly = useRoom((s) => s.hostOnlyControl);
  const queue = useRoom((s) => s.queue);

  return (
    <div className="wp-scroll flex-1 overflow-y-auto px-4 py-3">
      <ul className="space-y-1" aria-label="People in the room">
        {participants.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-xl px-2 py-1.5">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#5e5ce6] to-[#0a84ff] text-[13px] font-semibold text-white"
            >
              {p.nickname.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">
                {p.nickname}
                {p.id === me && <span className="font-normal text-neutral-500 dark:text-neutral-400"> (you)</span>}
              </span>
              {(p.isHost || buffering.includes(p.id)) && (
                <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">
                  {[p.isHost ? 'Host' : null, buffering.includes(p.id) ? 'Buffering…' : null].filter(Boolean).join(' · ')}
                </span>
              )}
            </span>
            <span className="flex gap-1.5 text-neutral-500 dark:text-neutral-400">
              {p.media.audio && <Mic aria-label="Microphone on" aria-hidden={false} role="img" />}
              {p.media.video && <Camera aria-label="Camera on" aria-hidden={false} role="img" />}
              {p.media.screen && <Screen aria-label="Sharing screen" aria-hidden={false} role="img" />}
            </span>
          </li>
        ))}
      </ul>
      {hostOnly && (
        <p className="mt-3 px-2 text-[12px] text-neutral-500 dark:text-neutral-400">Only the host controls playback.</p>
      )}
      {queue.length > 0 && (
        <section className="mt-5" aria-label="Up next">
          <h3 className="px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-500 dark:text-neutral-400">
            Up next
          </h3>
          <ol className="mt-1.5 space-y-0.5">
            {queue.map((q, i) => (
              <li key={q.id} className="flex gap-2 rounded-lg px-2 py-1 text-[13px]">
                <span className="w-4 shrink-0 text-right tabular-nums text-neutral-400">{i + 1}</span>
                <span className="min-w-0 truncate" title={q.mediaUrl}>
                  {q.title}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
