'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { roomCodeSchema, type ErrorCode } from '@watchparty/shared-types';
import { BufferingBanner } from '@/components/BufferingBanner';
import { CallBar } from '@/components/CallBar';
import { CallGrid, CamBubbles } from '@/components/CallGrid';
import { ChatPanel } from '@/components/ChatPanel';
import { HandedOff } from '@/components/ExtensionHandoff';
import { MediaUrlBar } from '@/components/MediaUrlBar';
import { Spinner } from '@/components/ModeBadge';
import { NicknameGate } from '@/components/NicknameGate';
import { ParticipantList } from '@/components/ParticipantList';
import { PlayerHost } from '@/components/PlayerHost';
import { QueuePanel } from '@/components/QueuePanel';
import { ReactionBar } from '@/components/ReactionBar';
import { ReactionOverlay } from '@/components/ReactionOverlay';
import { RoomHeader } from '@/components/RoomHeader';
import { disconnect, errorText, joinRoom, leaveRoom, toError } from '@/lib/socket';
import { readNickname, rememberRoom, rememberedRoom } from '@/lib/util';
import { startMesh, stopMesh } from '@/lib/webrtc';
import { useRoom } from '@/store/room';

// Leaving is deferred one tick so React StrictMode's mount → unmount → mount doesn't drop the seat.
let pendingLeave: ReturnType<typeof setTimeout> | null = null;

export default function RoomPage() {
  const params = useParams<{ code: string }>();
  const parsed = roomCodeSchema.safeParse(params.code);
  if (!parsed.success) {
    return (
      <main className="grid min-h-[70dvh] place-items-center px-4 text-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-title">Invalid room code</h1>
          <p className="mt-2 text-sm text-zinc-400">Room codes are six characters, like K7QX2M.</p>
          <Link href="/" className="btn-primary mt-6">
            Back to start
          </Link>
        </div>
      </main>
    );
  }
  return <Room code={parsed.data} />;
}

function Room({ code }: { code: string }) {
  const inRoom = useRoom((s) => s.session?.roomCode === code);
  const userId = useRoom((s) => s.session?.userId ?? null);
  const handedOff = useRoom((s) => s.handedOff);
  const lastError = useRoom((s) => s.lastError);
  const [pending, setPending] = useState(false);
  const [decided, setDecided] = useState(false);
  const [joinError, setJoinError] = useState<{ code: ErrorCode; message: string } | null>(null);

  const join = useCallback(
    async (nickname: string) => {
      setPending(true);
      setJoinError(null);
      try {
        await joinRoom(code, nickname);
      } catch (err: unknown) {
        setJoinError(toError(err));
        rememberRoom(null);
      } finally {
        setPending(false);
      }
    },
    [code],
  );

  useEffect(() => {
    if (pendingLeave) clearTimeout(pendingLeave);
    pendingLeave = null;
    const s = useRoom.getState();
    // Reload of a room this tab was in (or "Join" from the landing page): rejoin without prompting.
    if (s.session?.roomCode !== code && !s.handedOff) {
      const nick = readNickname();
      if (rememberedRoom() === code && nick) void join(nick);
    }
    setDecided(true);
    return () => {
      pendingLeave = setTimeout(() => {
        pendingLeave = null;
        stopMesh();
        leaveRoom();
        disconnect();
        rememberRoom(null);
      }, 0);
    };
  }, [code, join]);

  // No cleanup on a userId change: startMesh hands the live capture to the reconnected (new userId) manager.
  useEffect(() => {
    if (userId) startMesh(code, userId);
    else stopMesh();
  }, [code, userId]);
  useEffect(() => stopMesh, []);

  if (handedOff) {
    return (
      <HandedOff
        onRejoin={() => {
          useRoom.setState({ handedOff: false });
          const nick = readNickname();
          if (nick) void join(nick);
        }}
      />
    );
  }

  if (!inRoom) {
    if (!decided || (pending && !joinError)) {
      return (
        <main className="grid min-h-[70dvh] place-items-center text-sm text-zinc-400">
          <span className="inline-flex items-center gap-2">
            <Spinner /> Joining {code}…
          </span>
        </main>
      );
    }
    return <NicknameGate code={code} pending={pending} error={joinError ?? lastError} onJoin={(n) => void join(n)} />;
  }

  return (
    <main className="mx-auto grid max-w-[1600px] gap-4 px-4 py-4 sm:px-6 lg:h-[calc(100dvh-3.5rem)] lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="flex min-h-0 min-w-0 flex-col gap-3">
        <RoomHeader code={code} />
        <MediaUrlBar />
        <Stage />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ReactionBar />
          <CallBar />
        </div>
        <CallGrid />
      </section>
      <SidePanel />
      <ErrorToast />
    </main>
  );
}

/** Player + overlays. Fullscreen targets this box (not the <video>) so reactions and cam bubbles stay visible. */
function Stage() {
  const ref = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [canFull, setCanFull] = useState(false);
  useEffect(() => {
    setCanFull(document.fullscreenEnabled);
    const onChange = () => setFull(ref.current !== null && document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggle = () => {
    const p = full ? document.exitFullscreen() : ref.current?.requestFullscreen();
    p?.catch((err: unknown) => console.warn('Fullscreen failed', err));
  };
  return (
    <div
      ref={ref}
      className="relative aspect-video w-full overflow-hidden rounded-3xl bg-black shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] ring-1 ring-white/[0.06] lg:aspect-auto lg:min-h-0 lg:flex-1 [&:fullscreen]:rounded-none"
    >
      <PlayerHost />
      <ReactionOverlay />
      <BufferingBanner />
      {full && <CamBubbles />}
      {canFull && (
        <button
          type="button"
          onClick={toggle}
          aria-pressed={full}
          className="material pressable absolute left-3 top-3 z-40 rounded-full px-3 py-1.5 text-xs font-semibold tracking-caption opacity-70 hover:opacity-100 focus-visible:opacity-100"
        >
          {full ? 'Exit fullscreen' : 'Fullscreen'}
        </button>
      )}
    </div>
  );
}

type Tab = 'chat' | 'people' | 'queue';

function SidePanel() {
  const [tab, setTab] = useState<Tab>('chat');
  const people = useRoom((s) => s.participants.length);
  const queued = useRoom((s) => s.queue.length);
  const tabs: { id: Tab; label: string }[] = [
    { id: 'chat', label: 'Chat' },
    { id: 'people', label: `People · ${people}` },
    { id: 'queue', label: queued > 0 ? `Queue · ${queued}` : 'Queue' },
  ];
  return (
    <aside className="material-thick flex h-[70dvh] min-h-0 flex-col overflow-hidden rounded-3xl lg:h-auto">
      <div role="tablist" aria-label="Room panels" className="m-2 grid grid-cols-3 gap-1 rounded-xl bg-black/30 p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`pressable rounded-lg px-2 py-1.5 text-[13px] font-medium ${
              tab === t.id ? 'bg-white/[0.1] text-zinc-100 shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="min-h-0 flex-1">
        {tab === 'chat' && <ChatPanel />}
        {tab === 'people' && <ParticipantList />}
        {tab === 'queue' && <QueuePanel />}
      </div>
    </aside>
  );
}

const TOAST_MS = 3_500;

function ErrorToast() {
  const error = useRoom((s) => s.lastError);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => useRoom.setState({ lastError: null }), TOAST_MS);
    return () => clearTimeout(t);
  }, [error]);
  if (!error) return null;
  return (
    <div role="alert" className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
      <p className="material-thick animate-materialize pointer-events-auto rounded-2xl px-4 py-2.5 text-sm">
        <span className="mr-2 text-signal-warn">●</span>
        {errorText(error)}
      </p>
    </div>
  );
}
