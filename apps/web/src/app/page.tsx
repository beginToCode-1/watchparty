import { CreateRoomForm } from '@/components/CreateRoomForm';
import { JoinRoomForm } from '@/components/JoinRoomForm';

const MODES = [
  {
    mode: 'A',
    title: 'In-app player',
    body: 'YouTube, HLS streams, video files and local files play right here, kept within a frame or two of each other.',
  },
  {
    mode: 'B',
    title: 'Streaming services',
    body: 'Netflix, Prime Video, Disney+ and friends: everyone uses their own account and the WatchParty extension keeps you in sync.',
  },
  {
    mode: 'C',
    title: 'Share a tab',
    body: 'Anything else: one person shares a browser tab in 1080p60 with sound, everyone else watches the stream.',
  },
] as const;

export default function LandingPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 pb-24 pt-12 sm:px-6 sm:pt-20">
      <section className="max-w-3xl">
        <p className="badge bg-screen/15 text-screen">Watch together · voice · chat</p>
        <h1 className="mt-4 text-[clamp(2.25rem,6vw,4.25rem)] font-bold leading-[1.04] tracking-display">
          The same moment,
          <br />
          <span className="text-screen">on every screen.</span>
        </h1>
        <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-zinc-400">
          Paste a link, share a six-character code, and press play. Pauses, seeks and buffering follow everyone in the
          room.
        </p>
      </section>

      <section className="mt-10 grid gap-5 md:grid-cols-2">
        <CreateRoomForm />
        <JoinRoomForm />
      </section>

      <section className="mt-16 grid gap-4 sm:grid-cols-3" aria-label="Playback modes">
        {MODES.map((m) => (
          <article key={m.mode} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/[0.06] font-mono text-sm font-bold text-screen">
              {m.mode}
            </span>
            <h3 className="mt-3 text-[15px] font-semibold tracking-title">{m.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{m.body}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
