'use client';

import { useState } from 'react';
import type { Participant } from '@watchparty/shared-types';
import { getMesh } from '@/lib/webrtc';
import { useRoom } from '@/store/room';

function GainSlider({ peerId, kind, label }: { peerId: string; kind: 'voice' | 'screen'; label: string }) {
  const [value, setValue] = useState(() => getMesh()?.getGain(peerId, kind) ?? 1);
  const [before, setBefore] = useState(1);
  const set = (v: number) => {
    setValue(v);
    getMesh()?.setGain(peerId, kind, v);
  };
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="pressable w-6 shrink-0 text-sm"
        aria-label={value === 0 ? `Unmute ${label}` : `Mute ${label}`}
        aria-pressed={value === 0}
        onClick={() => {
          if (value === 0) set(before || 1);
          else {
            setBefore(value);
            set(0);
          }
        }}
      >
        {value === 0 ? '🔇' : kind === 'voice' ? '🔊' : '🖥️'}
      </button>
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={value}
        aria-label={`${label} volume`}
        onChange={(e) => set(Number(e.target.value))}
        className="h-1 w-full cursor-pointer accent-screen"
      />
      <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-zinc-500">{Math.round(value * 100)}%</span>
    </div>
  );
}

function Row({ p, me, buffering, speaking }: { p: Participant; me: boolean; buffering: boolean; speaking: boolean }) {
  return (
    <li className="rounded-xl px-3 py-2.5 hover:bg-white/[0.03]">
      <div className="flex items-center gap-3">
        <span
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink-700 text-sm font-semibold uppercase transition-shadow duration-150 ${
            speaking ? 'ring-2 ring-signal-live ring-offset-2 ring-offset-ink-900' : ''
          }`}
          aria-hidden
        >
          {p.nickname.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {p.nickname}
          {me && <span className="font-normal text-zinc-500"> (you)</span>}
        </span>
        {p.isHost && (
          <span title="Host" aria-label="Host">
            👑
          </span>
        )}
        {buffering && (
          <span className="badge bg-signal-warn/15 text-signal-warn" title="Buffering">
            buffering
          </span>
        )}
        <span className="flex gap-1 text-sm" aria-label="Media">
          <span className={p.media.audio ? '' : 'opacity-25'} title={p.media.audio ? 'Mic on' : 'Mic off'}>
            🎙️
          </span>
          <span className={p.media.video ? '' : 'opacity-25'} title={p.media.video ? 'Camera on' : 'Camera off'}>
            📷
          </span>
          {p.media.screen && <span title="Sharing screen">🖥️</span>}
        </span>
      </div>
      {!me && (p.media.audio || p.media.screen) && (
        <div className="mt-2 space-y-1.5 pl-11">
          {p.media.audio && <GainSlider peerId={p.id} kind="voice" label={`${p.nickname}'s voice`} />}
          {p.media.screen && <GainSlider peerId={p.id} kind="screen" label={`${p.nickname}'s screen audio`} />}
        </div>
      )}
    </li>
  );
}

export function ParticipantList() {
  const participants = useRoom((s) => s.participants);
  const me = useRoom((s) => s.session?.userId);
  const buffer = useRoom((s) => s.buffer);
  const speaking = useRoom((s) => s.call.speaking);
  return (
    <ul className="scroll-thin h-full space-y-0.5 overflow-y-auto p-2" aria-label="Participants">
      {participants.map((p) => (
        <Row
          key={p.id}
          p={p}
          me={p.id === me}
          buffering={buffer.waiting && buffer.userIds.includes(p.id)}
          speaking={speaking[p.id] === true}
        />
      ))}
    </ul>
  );
}
