import { DRIFT_IGNORE_S } from '@watchparty/shared-types';
import { useRoom } from './store';

type Tone = 'ok' | 'busy' | 'idle' | 'bad';

const DOT: Record<Tone, string> = {
  ok: 'bg-[#30d158]',
  busy: 'bg-[#ff9f0a]',
  idle: 'bg-neutral-400',
  bad: 'bg-[#ff453a]',
};

export function SyncStatus({ onRetry }: { onRetry: () => void }) {
  const phase = useRoom((s) => s.phase);
  const video = useRoom((s) => s.video);
  const sync = useRoom((s) => s.sync);
  const buffer = useRoom((s) => s.buffer);
  const participants = useRoom((s) => s.participants);

  let tone: Tone = 'ok';
  let text = 'In sync';
  if (phase === 'connecting') [tone, text] = ['busy', 'Connecting…'];
  else if (phase === 'reconnecting') [tone, text] = ['busy', 'Reconnecting…'];
  else if (buffer.waiting) {
    const names = participants.filter((p) => buffer.userIds.includes(p.id)).map((p) => p.nickname);
    [tone, text] = ['busy', names.length ? `Waiting for ${names.join(', ')}…` : 'Waiting for everyone…'];
  } else if (video === 'searching') [tone, text] = ['idle', 'Looking for the video…'];
  else if (video === 'missing') [tone, text] = ['bad', 'No video found. Start playback, then retry.'];
  else if (sync?.drift != null && Math.abs(sync.drift) >= DRIFT_IGNORE_S) {
    const d = sync.drift;
    [tone, text] = ['busy', `Catching up · ${d > 0 ? '+' : ''}${d.toFixed(2)}s`];
  }

  return (
    <div className="flex items-center gap-2 px-4 pb-3 text-[12px] text-neutral-600 dark:text-neutral-300" role="status">
      <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {video === 'missing' && phase === 'joined' && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full px-2 py-0.5 font-medium text-[#007aff] transition-transform active:scale-[0.95] dark:text-[#0a84ff]"
        >
          Retry
        </button>
      )}
      {sync && phase === 'joined' && video === 'syncing' && (
        <span className="tabular-nums text-neutral-400" title="Round trip to the server">
          {Math.round(sync.rtt)} ms
        </span>
      )}
    </div>
  );
}
