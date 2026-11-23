'use client';

import { REACTION_EMOJIS, type ReactionEmoji } from '@watchparty/shared-types';
import { act } from '@/lib/socket';

const LABELS: Record<ReactionEmoji, string> = {
  '👍': 'Thumbs up',
  '👎': 'Thumbs down',
  '😂': 'Laughing',
  '😮': 'Surprised',
  '😢': 'Sad',
  '😡': 'Angry',
  '❤️': 'Love',
  '🔥': 'Fire',
  '👏': 'Applause',
  '🎉': 'Party',
  '💀': 'Dead',
  '🍿': 'Popcorn',
};

export function ReactionBar() {
  return (
    <div role="toolbar" aria-label="Reactions" className="flex flex-wrap gap-1">
      {REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          aria-label={LABELS[emoji]}
          title={LABELS[emoji]}
          className="pressable grid h-9 w-9 place-items-center rounded-full text-xl hover:bg-white/[0.08] active:bg-white/[0.14]"
          onPointerDown={(e) => {
            // Fire on press, not release: the reaction should feel instant.
            if (e.button === 0) void act('reaction:send', { emoji });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void act('reaction:send', { emoji });
            }
          }}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
