import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CHAT_TEXT_MAX } from '@watchparty/shared-types';
import { parseTimecode } from '@watchparty/sync-engine';
import { Send } from './icons';
import { useRoom } from './store';

const TAG_RE = /(@\d{1,2}:[0-5]\d(?::[0-5]\d)?)/g;
const STICK_PX = 48;

/** Text nodes only; `@m:ss` / `@h:mm:ss` tags become seek buttons. */
function renderText(text: string, onSeek: (s: number) => void): ReactNode[] {
  return text.split(TAG_RE).map((part, i) => {
    const seconds = i % 2 === 1 ? parseTimecode(part.slice(1)) : null;
    if (seconds === null) return part;
    return (
      <button
        key={i}
        type="button"
        onClick={() => onSeek(seconds)}
        className="rounded font-semibold underline decoration-1 underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-current"
      >
        {part}
      </button>
    );
  });
}

export function Chat({
  onSend,
  onSeek,
  children,
}: {
  onSend: (text: string) => void;
  onSeek: (s: number) => void;
  /** Rendered between the message list and the input (the reaction bar). */
  children?: ReactNode;
}) {
  const chat = useRoom((s) => s.chat);
  const me = useRoom((s) => s.userId);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [draft, setDraft] = useState('');

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
    stick.current = true;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}
        className="wp-scroll flex-1 space-y-1 overflow-y-auto px-4 py-3"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {chat.length === 0 && (
          <p className="pt-8 text-center text-[13px] text-neutral-500 dark:text-neutral-400">
            No messages yet. Type <span className="font-medium">@1:23</span> to share a moment.
          </p>
        )}
        {chat.map((m, i) => {
          const mine = m.userId === me;
          const first = chat[i - 1]?.userId !== m.userId;
          return (
            <div key={m.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'} ${first ? 'pt-2' : ''}`}>
              {first && !mine && (
                <span className="mb-0.5 px-3 text-[11px] font-medium tracking-[0.01em] text-neutral-500 dark:text-neutral-400">
                  {m.nickname}
                </span>
              )}
              <p
                title={new Date(m.at).toLocaleTimeString()}
                className={`max-w-[85%] whitespace-pre-wrap break-words rounded-[18px] px-3 py-1.5 text-[14px] leading-[1.35] ${
                  mine
                    ? 'bg-[#007aff] text-white dark:bg-[#0a84ff]'
                    : 'bg-black/[0.06] text-neutral-900 dark:bg-white/10 dark:text-neutral-100'
                }`}
              >
                {renderText(m.text, onSeek)}
              </p>
            </div>
          );
        })}
      </div>
      {children}
      <form onSubmit={submit} className="flex items-center gap-2 px-3 pb-3 pt-1">
        <label htmlFor="wp-chat-input" className="sr-only">
          Chat message
        </label>
        <input
          id="wp-chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={CHAT_TEXT_MAX}
          autoComplete="off"
          placeholder="Message"
          className="h-9 min-w-0 flex-1 rounded-full border border-black/10 bg-white/70 px-4 text-[14px] text-neutral-900 placeholder:text-neutral-400 focus:border-[#007aff] focus:outline-none focus:ring-2 focus:ring-[#007aff]/30 dark:border-white/10 dark:bg-white/[0.08] dark:text-neutral-100"
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={draft.trim().length === 0}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#007aff] text-white transition-[transform,opacity] duration-100 active:scale-[0.92] disabled:opacity-30 dark:bg-[#0a84ff]"
        >
          <Send width={18} height={18} />
        </button>
      </form>
    </div>
  );
}
