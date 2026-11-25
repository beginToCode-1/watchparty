'use client';

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { readPref, writePref } from '@/lib/util';
import { useRoom } from '@/store/room';
import { StreamVideo } from './StreamVideo';

const SPEAKING_RING = 'shadow-[0_0_0_3px_theme(colors.signal.live),0_0_24px_rgba(61,220,132,0.45)]';
const IDLE_RING = 'shadow-[0_0_0_1px_rgba(255,255,255,0.08)]';

/** Everyone in the room with their camera stream (null when off), speaking and mic state. */
function usePeople() {
  const participants = useRoom((s) => s.participants);
  const me = useRoom((s) => s.session?.userId);
  const call = useRoom((s) => s.call);
  return participants.map((p) => {
    const mine = p.id === me;
    return {
      id: p.id,
      name: mine ? 'You' : p.nickname,
      initial: p.nickname.slice(0, 1),
      mine,
      stream: mine ? (call.cam ? call.localCam : null) : p.media.video ? (call.remote[p.id]?.cam ?? null) : null,
      speaking: call.speaking[p.id] === true,
      micOn: mine ? call.mic : p.media.audio,
    };
  });
}

/** Meet-style strip under the player: one tile per person, camera when on, initial otherwise. */
export function CallGrid() {
  const people = usePeople();
  if (people.length === 0) return null;
  return (
    <ul className="scroll-thin flex gap-2 overflow-x-auto pb-1" aria-label="People in the room">
      {people.map((p) => (
        <li
          key={p.id}
          className={`animate-materialize relative aspect-video w-40 shrink-0 overflow-hidden rounded-2xl bg-ink-700 transition-[box-shadow] duration-150 ${
            p.speaking ? SPEAKING_RING : IDLE_RING
          }`}
        >
          {p.stream ? (
            <StreamVideo stream={p.stream} mirrored={p.mine} label={p.mine ? 'Your camera' : `${p.name}'s camera`} className="h-full w-full object-cover" />
          ) : (
            <span className="grid h-full w-full place-items-center" aria-hidden>
              <span className="grid h-12 w-12 place-items-center rounded-full bg-white/10 text-xl font-semibold uppercase text-zinc-200">
                {p.initial}
              </span>
            </span>
          )}
          <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1 pt-4 text-[11px] text-zinc-100">
            <span className="truncate">{p.name}</span>
            {!p.micOn && <span aria-label="Muted">🔇</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const POS_KEY = 'wp:bubbles';
const KEY_STEP = 0.05;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function readPos(): { x: number; y: number } {
  const [x, y] = (readPref(POS_KEY) ?? '').split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: clamp01(x ?? 1), y: clamp01(y ?? 1) } : { x: 1, y: 1 };
}

/**
 * Floating camera bubbles for fullscreen. Position is a 0..1 fraction of the free space on each axis
 * (left: x%, translate: -x% of own size), so it stays on-screen through any resize.
 */
export function CamBubbles() {
  const people = usePeople();
  const [pos, setPos] = useState(readPos);
  const drag = useRef<{ px: number; py: number; x: number; y: number; freeW: number; freeH: number } | null>(null);

  const move = (x: number, y: number) => {
    const next = { x: clamp01(x), y: clamp01(y) };
    setPos(next);
    return next;
  };
  const save = (p: { x: number; y: number }) => writePref(POS_KEY, `${p.x},${p.y}`);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const parent = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!parent) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, ...pos, freeW: Math.max(1, parent.width - box.width), freeH: Math.max(1, parent.height - box.height) };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) move(d.x + (e.clientX - d.px) / d.freeW, d.y + (e.clientY - d.py) / d.freeH);
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    save(pos);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dx = e.key === 'ArrowLeft' ? -KEY_STEP : e.key === 'ArrowRight' ? KEY_STEP : 0;
    const dy = e.key === 'ArrowUp' ? -KEY_STEP : e.key === 'ArrowDown' ? KEY_STEP : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    save(move(pos.x + dx, pos.y + dy));
  };

  if (people.length === 0) return null;
  return (
    <div
      role="group"
      tabIndex={0}
      aria-label="Webcams. Drag or use arrow keys to move."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%`, transform: `translate(${-pos.x * 100}%, ${-pos.y * 100}%)` }}
      className="absolute z-40 flex max-w-[22rem] cursor-grab touch-none select-none flex-wrap gap-2 p-3 outline-none focus-visible:rounded-2xl focus-visible:ring-2 focus-visible:ring-screen active:cursor-grabbing"
    >
      {people.map((p) => (
        <div
          key={p.id}
          title={p.name}
          className={`relative h-20 w-20 overflow-hidden rounded-full bg-ink-700 transition-[box-shadow] duration-150 ${
            p.speaking ? SPEAKING_RING : IDLE_RING
          }`}
        >
          {p.stream ? (
            <StreamVideo stream={p.stream} mirrored={p.mine} label={p.mine ? 'Your camera' : `${p.name}'s camera`} className="pointer-events-none h-full w-full object-cover" />
          ) : (
            <span className="grid h-full w-full place-items-center text-2xl font-semibold uppercase text-zinc-300" aria-hidden>
              {p.initial}
            </span>
          )}
          {!p.micOn && (
            <span className="absolute bottom-1 right-1 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-[10px]" aria-label="Muted">
              🔇
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
