'use client';

import { useRoom } from '@/store/room';

export function BufferingBanner() {
  const buffer = useRoom((s) => s.buffer);
  const participants = useRoom((s) => s.participants);
  const me = useRoom((s) => s.session?.userId);
  const names = buffer.userIds.map((id) => (id === me ? 'you' : (participants.find((p) => p.id === id)?.nickname ?? 'someone')));

  return (
    <div aria-live="polite" className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
      {buffer.waiting && (
        <p className="material animate-materialize inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium">
          <span className="h-2 w-2 rounded-full bg-signal-warn motion-safe:animate-pulse" aria-hidden />
          Waiting for {names.length > 0 ? names.join(', ') : 'everyone'}…
        </p>
      )}
    </div>
  );
}
