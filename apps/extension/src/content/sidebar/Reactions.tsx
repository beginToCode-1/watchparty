import { REACTION_EMOJIS, type ReactionEmoji } from '@watchparty/shared-types';
import { useRoom } from './store';

export function ReactionBar({ onSend }: { onSend: (emoji: ReactionEmoji) => void }) {
  return (
    <div role="toolbar" aria-label="Reactions" className="wp-scroll flex gap-0.5 overflow-x-auto px-3 pb-1">
      {REACTION_EMOJIS.map((e) => (
        <button
          key={e}
          type="button"
          aria-label={`React ${e}`}
          onClick={() => onSend(e)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[18px] transition-transform duration-100 hover:bg-black/5 active:scale-[0.85] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#007aff] dark:hover:bg-white/10"
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/** Reactions from everyone float up over the lower part of the panel for 3 s. */
export function FloatingReactions() {
  const reactions = useRoom((s) => s.reactions);
  const participants = useRoom((s) => s.participants);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-28 h-0">
      {reactions.map((r) => {
        // Stable horizontal lane per reaction id so concurrent bursts do not stack.
        const lane = (parseInt(r.id.slice(0, 2), 16) % 5) * 18 + 12;
        const who = participants.find((p) => p.id === r.userId)?.nickname;
        return (
          <span key={r.id} className="wp-rise absolute bottom-0 flex flex-col items-center" style={{ right: `${lane}%` }}>
            <span className="text-[30px] leading-none drop-shadow">{r.emoji}</span>
            {who && (
              <span className="mt-1 rounded-full bg-black/50 px-1.5 text-[10px] font-medium text-white">{who}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
