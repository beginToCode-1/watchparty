'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactionEmoji } from '@watchparty/shared-types';
import { useRoom } from '@/store/room';

// Floating reactions. One rAF loop integrates springs per particle and writes transform/opacity only.
// Springs are parameterised like Apple's (damping ratio + response): k = (2π/response)², c = 2ζ·(2π/response).
const LIFE_S = 2.8;
const MAX_PARTICLES = 40;
const SCALE_SPRING = { damping: 0.55, response: 0.35 }; // pop-in: a little overshoot, it was "thrown" in
const SWAY_SPRING = { damping: 0.8, response: 0.6 };

interface Particle {
  el: HTMLSpanElement | null;
  bornAt: number;
  reduced: boolean;
  x: number;
  vx: number;
  baseX: number;
  swayAmp: number;
  swayHz: number;
  swayPhase: number;
  y: number;
  vy: number;
  scale: number;
  vScale: number;
}

const springStep = (x: number, v: number, target: number, s: { damping: number; response: number }, dt: number) => {
  const w = (2 * Math.PI) / s.response;
  const a = -w * w * (x - target) - 2 * s.damping * w * v;
  const nv = v + a * dt;
  return [x + nv * dt, nv] as const;
};

export function ReactionOverlay() {
  const reactions = useRoom((s) => s.reactions);
  const box = useRef<HTMLDivElement>(null);
  const particles = useRef(new Map<string, Particle>());
  const seen = useRef(new Set<string>());
  const raf = useRef<number | null>(null);
  const [items, setItems] = useState<{ id: string; emoji: ReactionEmoji }[]>([]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fresh = reactions.filter((r) => !seen.current.has(r.id));
    seen.current = new Set(reactions.map((r) => r.id));
    if (fresh.length === 0) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const now = performance.now();
    for (const r of fresh) {
      const baseX = w * (0.62 + Math.random() * 0.3);
      particles.current.set(r.id, {
        el: null,
        bornAt: now,
        reduced,
        x: baseX,
        vx: (Math.random() - 0.5) * 160,
        baseX,
        swayAmp: 14 + Math.random() * 22,
        swayHz: 0.9 + Math.random() * 0.7,
        swayPhase: Math.random() * Math.PI * 2,
        y: reduced ? h * (0.45 + Math.random() * 0.3) : h - 24,
        vy: -(h * 0.55 + Math.random() * h * 0.25),
        scale: reduced ? 1 : 0.3,
        vScale: reduced ? 0 : 6,
      });
    }
    setItems((prev) => [...prev, ...fresh.map((r) => ({ id: r.id, emoji: r.emoji }))].slice(-MAX_PARTICLES));
    if (raf.current === null) {
      let last = performance.now();
      const tick = (t: number) => {
        const dt = Math.min(0.05, (t - last) / 1000);
        last = t;
        const done: string[] = [];
        for (const [id, p] of particles.current) {
          const age = (t - p.bornAt) / 1000;
          if (age >= LIFE_S) {
            done.push(id);
            continue;
          }
          if (!p.reduced) {
            // Rise with air drag, sway toward a moving target, pop the scale in on a spring.
            p.vy *= Math.exp(-0.9 * dt);
            p.y += p.vy * dt;
            const target = p.baseX + p.swayAmp * Math.sin(2 * Math.PI * p.swayHz * age + p.swayPhase);
            [p.x, p.vx] = springStep(p.x, p.vx, target, SWAY_SPRING, dt);
            [p.scale, p.vScale] = springStep(p.scale, p.vScale, 1, SCALE_SPRING, dt);
          }
          const fadeIn = Math.min(1, age / 0.12);
          const fadeOut = Math.min(1, (LIFE_S - age) / (LIFE_S * 0.35));
          if (p.el) {
            p.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${p.scale.toFixed(3)})`;
            p.el.style.opacity = String(Math.min(fadeIn, fadeOut));
          }
        }
        if (done.length > 0) {
          for (const id of done) particles.current.delete(id);
          setItems((prev) => prev.filter((i) => !done.includes(i.id)));
        }
        raf.current = particles.current.size > 0 ? requestAnimationFrame(tick) : null;
      };
      raf.current = requestAnimationFrame(tick);
    }
  }, [reactions]);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    },
    [],
  );

  return (
    <div ref={box} aria-hidden className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {items.map((i) => (
        <span
          key={i.id}
          ref={(el) => {
            const p = particles.current.get(i.id);
            if (p) p.el = el;
          }}
          className="absolute left-0 top-0 select-none text-4xl opacity-0 will-change-transform [filter:drop-shadow(0_4px_10px_rgba(0,0,0,0.45))]"
        >
          {i.emoji}
        </span>
      ))}
    </div>
  );
}
