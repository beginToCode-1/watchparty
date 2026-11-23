'use client';

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { CHAT_TEXT_MAX } from '@watchparty/shared-types';
import { formatTimecode } from '@watchparty/sync-engine/timecode';
import { RoomError, request, roomPositionNow, toError } from '@/lib/socket';
import { canControl, useRoom } from '@/store/room';
import { ChatMessage } from './ChatMessage';

const SLOW_DOWN_MS = 2_000;
const STICK_PX = 48;

export function ChatPanel() {
  const chat = useRoom((s) => s.chat);
  const me = useRoom((s) => s.session?.userId);
  const control = useRoom(canControl);
  const seekable = useRoom((s) => s.state?.mode === 'A' || s.state?.mode === 'B');
  const hasMedia = useRoom((s) => !!s.state?.mediaUrl && s.state.mode !== 'C');
  const [text, setText] = useState('');
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stuck = useRef(true);

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [chat]);

  useEffect(() => {
    if (!slow) return;
    const t = setTimeout(() => setSlow(false), SLOW_DOWN_MS);
    return () => clearTimeout(t);
  }, [slow]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || slow) return;
    setError(null);
    try {
      await request('chat:send', { text: body });
      setText('');
      stuck.current = true;
    } catch (err: unknown) {
      if (err instanceof RoomError && err.code === 'RATE_LIMITED') setSlow(true);
      else setError(toError(err).message);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  function insertTime() {
    const tag = `@${formatTimecode(roomPositionNow())} `;
    const el = input.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = (text.slice(0, start) + tag + text.slice(end)).slice(0, CHAT_TEXT_MAX);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      const caret = Math.min(start + tag.length, next.length);
      el?.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ol
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto py-2"
        aria-label="Chat messages"
        aria-live="polite"
      >
        {chat.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-zinc-500">
            Say hi. Type <span className="font-mono text-zinc-300">@1:30</span> to drop a clickable timestamp.
          </li>
        )}
        {chat.map((m) => (
          <ChatMessage key={m.id} msg={m} mine={m.userId === me} canSeek={control && seekable} />
        ))}
      </ol>
      <form onSubmit={(e) => void send(e)} className="border-t border-white/[0.06] p-2">
        <div className="flex items-end gap-2">
          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <textarea
            id="chat-input"
            ref={input}
            rows={1}
            value={text}
            maxLength={CHAT_TEXT_MAX}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder="Message"
            className="field max-h-28 min-h-[42px] resize-none py-2.5"
          />
          <button
            type="button"
            className="icon-btn shrink-0 text-base"
            onClick={insertTime}
            disabled={!hasMedia}
            aria-label="Insert current time"
            title="Insert current time"
          >
            ⏱
          </button>
          <button type="submit" className="btn-primary h-[42px] shrink-0" disabled={!text.trim() || slow}>
            Send
          </button>
        </div>
        <div className="mt-1 flex justify-between px-1 text-[11px] text-zinc-500" aria-live="polite">
          <span className={slow || error ? 'text-signal-warn' : ''}>{slow ? 'Slow down a little…' : (error ?? '')}</span>
          <span className="tabular-nums">
            {text.length}/{CHAT_TEXT_MAX}
          </span>
        </div>
      </form>
    </div>
  );
}
