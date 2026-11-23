import { useState } from 'react';
import type { ReactionEmoji } from '@watchparty/shared-types';
import { formatTimecode } from '@watchparty/sync-engine';
import { bareHost } from '../../bridge';
import { Chat } from './Chat';
import { Check, ChevronLeft, ChevronRight, Copy } from './icons';
import { JoinPrompt, primaryButton, secondaryButton } from './JoinPrompt';
import { Participants } from './Participants';
import { FloatingReactions, ReactionBar } from './Reactions';
import { useRoom, type Notice } from './store';
import { SyncStatus } from './SyncStatus';

const WEB_URL = import.meta.env.VITE_WEB_URL;

/** Callbacks into content/index.tsx, which owns the socket. */
export interface SidebarActions {
  join(code: string, nickname: string): void;
  dismissPrompt(): void;
  leave(): void;
  sendChat(text: string): void;
  sendReaction(emoji: ReactionEmoji): void;
  seekTo(seconds: number): void;
  loadHere(): void;
  goToParty(url: string): void;
  resumeAutoplay(): void;
  retryScan(): void;
  setCollapsed(collapsed: boolean): void;
  dismissNotice(): void;
}

const iconButton =
  'flex h-8 w-8 items-center justify-center rounded-full text-neutral-500 transition-transform duration-100 hover:bg-black/5 active:scale-[0.9] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#007aff] dark:text-neutral-400 dark:hover:bg-white/10';
const smallButton =
  'rounded-full px-3 py-1 text-[12px] font-semibold transition-transform duration-100 active:scale-[0.95]';

function NoticeCard({ notice, actions, roomCode }: { notice: Notice; actions: SidebarActions; roomCode: string | null }) {
  let body: string;
  let buttons: { label: string; onClick: () => void; primary?: boolean }[] = [];
  switch (notice.kind) {
    case 'navigated':
      body = notice.canLoad ? 'Load this for everyone?' : "You navigated away from the party's video.";
      buttons = [
        ...(notice.canLoad ? [{ label: 'Load for everyone', onClick: actions.loadHere, primary: true }] : []),
        { label: 'Go back', onClick: () => actions.goToParty(notice.partyUrl) },
      ];
      break;
    case 'switched':
      body = `The party switched to ${bareHost(notice.url)}.`;
      buttons = [
        ...(roomCode
          ? [{ label: 'Open in web app', onClick: () => void window.open(`${WEB_URL}/room/${roomCode}`, '_blank'), primary: true }]
          : []),
        { label: 'Dismiss', onClick: actions.dismissNotice },
      ];
      break;
    case 'iframe':
      body = 'The player is in an embedded frame the extension cannot reach.';
      buttons = [
        {
          label: 'Open player in a new tab',
          onClick: () => void window.open(`${notice.src.split('#')[0] ?? notice.src}#wp=${roomCode ?? ''}`, '_blank'),
          primary: true,
        },
        { label: 'Dismiss', onClick: actions.dismissNotice },
      ];
      break;
    case 'manualSeek':
      body = `This site blocked the seek. Seek manually to ${formatTimecode(notice.position)}.`;
      buttons = [{ label: 'Dismiss', onClick: actions.dismissNotice }];
      break;
  }
  return (
    <div className="mx-3 mb-3 rounded-2xl bg-black/[0.05] p-3 dark:bg-white/[0.08]" role="alert">
      <p className="text-[13px] leading-snug">{body}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {buttons.map((b) => (
          <button
            key={b.label}
            type="button"
            onClick={b.onClick}
            className={`${smallButton} ${
              b.primary ? 'bg-[#007aff] text-white dark:bg-[#0a84ff]' : 'text-[#007aff] hover:bg-black/5 dark:text-[#0a84ff] dark:hover:bg-white/10'
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RoomCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Room code ${code.split('').join(' ')}, copy`}
      className="group -ml-1 flex items-center gap-2 rounded-lg px-1 transition-transform duration-100 active:scale-[0.97]"
    >
      <span className="font-mono text-[24px] font-semibold leading-none tracking-[0.14em]">{code}</span>
      <span className="text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-200">
        {copied ? <Check className="text-[#30d158]" /> : <Copy />}
      </span>
    </button>
  );
}

export function Sidebar({ actions }: { actions: SidebarActions }) {
  const phase = useRoom((s) => s.phase);
  const collapsed = useRoom((s) => s.collapsed);
  const roomCode = useRoom((s) => s.roomCode);
  const promptCode = useRoom((s) => s.promptCode);
  const error = useRoom((s) => s.error);
  const notice = useRoom((s) => s.notice);
  const toast = useRoom((s) => s.toast);
  const unread = useRoom((s) => s.unread);
  const autoplayBlocked = useRoom((s) => s.autoplayBlocked);
  const count = useRoom((s) => s.participants.length);
  const [tab, setTab] = useState<'chat' | 'people'>('chat');
  const inRoom = phase === 'joined' || phase === 'reconnecting' || phase === 'connecting';

  return (
    <div className="pointer-events-none relative flex h-full justify-end">
      <button
        type="button"
        onClick={() => actions.setCollapsed(false)}
        aria-label={unread > 0 ? `Open WatchParty, ${unread} unread` : 'Open WatchParty'}
        tabIndex={collapsed ? 0 : -1}
        className={`wp-glass absolute right-0 top-1/2 flex h-24 w-11 -translate-y-1/2 flex-col items-center justify-center gap-1 rounded-l-2xl border border-r-0 border-black/10 shadow-lg transition-[opacity,transform] duration-300 ease-sheet active:scale-[0.96] motion-reduce:transition-opacity dark:border-white/10 ${
          collapsed ? 'pointer-events-auto opacity-100' : 'translate-x-full opacity-0'
        }`}
      >
        <ChevronLeft width={18} height={18} />
        {unread > 0 && (
          <span className="min-w-[18px] rounded-full bg-[#ff453a] px-1 text-[11px] font-semibold leading-[18px] text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      <aside
        role="complementary"
        aria-label="WatchParty"
        inert={collapsed}
        onKeyDown={(e) => {
          if (e.key === 'Escape') actions.setCollapsed(true);
        }}
        className={`wp-glass relative flex h-full w-[360px] flex-col border-l border-black/10 shadow-[0_0_40px_rgba(0,0,0,0.25)] transition-transform duration-300 ease-sheet motion-reduce:transition-none dark:border-white/10 ${
          collapsed ? 'translate-x-full' : 'pointer-events-auto translate-x-0'
        }`}
      >
        <header className="flex items-start justify-between px-4 pb-2 pt-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-400">
              WatchParty
            </p>
            {roomCode && inRoom ? <RoomCode code={roomCode} /> : null}
          </div>
          <div className="flex items-center gap-1">
            {inRoom && (
              <button type="button" onClick={actions.leave} className={`${smallButton} text-[#ff3b30] hover:bg-black/5 dark:text-[#ff453a] dark:hover:bg-white/10`}>
                Leave
              </button>
            )}
            <button type="button" aria-label="Collapse sidebar" onClick={() => actions.setCollapsed(true)} className={iconButton}>
              <ChevronRight width={18} height={18} />
            </button>
          </div>
        </header>

        {phase === 'prompt' || phase === 'idle' ? (
          <JoinPrompt key={promptCode} onJoin={actions.join} onDismiss={actions.dismissPrompt} />
        ) : phase === 'error' ? (
          <div className="flex flex-1 flex-col gap-3 px-4 py-4">
            <h2 className="text-[20px] font-semibold leading-tight tracking-[-0.01em]">Could not join</h2>
            <p className="text-[14px] text-neutral-600 dark:text-neutral-300">{error ?? 'Something went wrong.'}</p>
            <button type="button" onClick={() => useRoom.setState({ phase: 'prompt', promptCode: roomCode ?? '' })} className={primaryButton}>
              Try another code
            </button>
            <button type="button" onClick={actions.leave} className={secondaryButton}>
              Close
            </button>
          </div>
        ) : (
          <>
            <SyncStatus onRetry={actions.retryScan} />
            {autoplayBlocked && (
              <div className="mx-3 mb-3">
                <button type="button" onClick={actions.resumeAutoplay} className={primaryButton}>
                  Click to start synced playback
                </button>
              </div>
            )}
            {notice && <NoticeCard notice={notice} actions={actions} roomCode={roomCode} />}
            <div role="tablist" aria-label="Sidebar sections" className="mx-4 mb-1 flex rounded-[10px] bg-black/[0.06] p-0.5 dark:bg-white/10">
              {(['chat', 'people'] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  type="button"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`h-7 flex-1 rounded-[8px] text-[13px] font-medium transition-[background-color,box-shadow] duration-200 ${
                    tab === t ? 'bg-white shadow-sm dark:bg-white/20' : 'text-neutral-500 dark:text-neutral-400'
                  }`}
                >
                  {t === 'chat' ? 'Chat' : `People · ${count}`}
                </button>
              ))}
            </div>
            {tab === 'chat' ? (
              <Chat onSend={actions.sendChat} onSeek={actions.seekTo}>
                <ReactionBar onSend={actions.sendReaction} />
              </Chat>
            ) : (
              <Participants />
            )}
            <FloatingReactions />
          </>
        )}

        {toast && (
          <div
            role="status"
            className="pointer-events-none absolute inset-x-4 bottom-24 rounded-xl bg-neutral-900/90 px-3 py-2 text-center text-[13px] text-white shadow-lg dark:bg-neutral-100/90 dark:text-neutral-900"
          >
            {toast}
          </div>
        )}
      </aside>
    </div>
  );
}
