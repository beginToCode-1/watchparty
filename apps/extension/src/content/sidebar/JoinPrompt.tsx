import { useState, type FormEvent } from 'react';
import { NICKNAME_MAX, filterCode, nicknameSchema, roomCodeSchema } from '@watchparty/shared-types';
import { useRoom } from './store';

export const fieldClass =
  'h-10 w-full rounded-xl border border-black/10 bg-white/70 px-3 text-[15px] text-neutral-900 placeholder:text-neutral-400 focus:border-[#007aff] focus:outline-none focus:ring-2 focus:ring-[#007aff]/30 dark:border-white/10 dark:bg-white/[0.08] dark:text-neutral-100';
export const primaryButton =
  'h-10 w-full rounded-xl bg-[#007aff] text-[15px] font-semibold text-white transition-[transform,opacity] duration-100 active:scale-[0.97] disabled:opacity-40 dark:bg-[#0a84ff]';
export const secondaryButton =
  'h-10 w-full rounded-xl text-[15px] font-medium text-[#007aff] transition-transform duration-100 hover:bg-black/5 active:scale-[0.97] dark:text-[#0a84ff] dark:hover:bg-white/10';

const labelText = 'mb-1 block text-[12px] font-medium text-neutral-500 dark:text-neutral-400';

/** Room code + nickname inputs (sidebar prompt and popup). The code field is hidden when `code` is undefined. */
export function CodeNameFields(props: {
  code?: string | undefined;
  onCode: (code: string) => void;
  nickname: string;
  onNickname: (nickname: string) => void;
}) {
  return (
    <>
      {props.code !== undefined && (
        <label className="block">
          <span className={labelText}>Room code</span>
          <input
            value={props.code}
            onChange={(e) => props.onCode(filterCode(e.target.value))}
            autoComplete="off"
            spellCheck={false}
            placeholder="ABC234"
            className={`${fieldClass} font-mono tracking-[0.2em]`}
          />
        </label>
      )}
      <label className="block">
        <span className={labelText}>Your name</span>
        <input
          value={props.nickname}
          onChange={(e) => props.onNickname(e.target.value)}
          maxLength={NICKNAME_MAX}
          autoComplete="nickname"
          placeholder="Alex"
          className={fieldClass}
        />
      </label>
    </>
  );
}

/** Shown for a `#wp=CODE` link (or a manual toggle with no session). Joining always needs this explicit click. */
export function JoinPrompt({ onJoin, onDismiss }: { onJoin: (code: string, nickname: string) => void; onDismiss: () => void }) {
  const promptCode = useRoom((s) => s.promptCode);
  const savedNickname = useRoom((s) => s.nickname);
  const [code, setCode] = useState(promptCode);
  const [nickname, setNickname] = useState(savedNickname);
  const valid = roomCodeSchema.safeParse(code).success && nicknameSchema.safeParse(nickname).success;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onJoin(code, nickname.trim());
  };

  return (
    <form onSubmit={submit} className="flex flex-1 flex-col gap-3 px-4 py-4">
      <div>
        <h2 className="text-[20px] font-semibold leading-tight tracking-[-0.01em]">Join the watch party</h2>
        <p className="mt-1 text-[13px] text-neutral-500 dark:text-neutral-400">
          You will sync this tab&apos;s video with everyone in the room.
        </p>
      </div>
      <CodeNameFields code={code} onCode={setCode} nickname={nickname} onNickname={setNickname} />
      <button type="submit" disabled={!valid} className={`${primaryButton} mt-1`}>
        Join room
      </button>
      <button type="button" onClick={onDismiss} className={secondaryButton}>
        Not now
      </button>
    </form>
  );
}
