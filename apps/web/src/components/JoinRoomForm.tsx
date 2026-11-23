'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { NICKNAME_MAX, ROOM_CODE_LENGTH, ROOM_CODE_REGEX, filterCode } from '@watchparty/shared-types';
import { readNickname, rememberRoom, writePref } from '@/lib/util';

export function JoinRoomForm() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [nickname, setNickname] = useState('');
  const valid = ROOM_CODE_REGEX.test(code) && nickname.trim().length > 0;

  useEffect(() => setNickname((n) => n || readNickname()), []);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    writePref('wp:nickname', nickname.trim());
    rememberRoom(code); // the room page joins straight away with the remembered nickname
    router.push(`/room/${code}`);
  }

  return (
    <form onSubmit={submit} className="material animate-materialize rounded-3xl p-6 [animation-delay:60ms] sm:p-7">
      <h2 className="text-xl font-semibold tracking-title">Join with a code</h2>
      <p className="mt-1 text-sm text-zinc-400">Six characters — no 0, O, 1 or I.</p>
      <div className="mt-5 space-y-4">
        <div>
          <label htmlFor="join-code" className="label">
            Room code
          </label>
          <input
            id="join-code"
            className="field text-center font-mono text-2xl font-semibold tracking-[0.35em]"
            value={code}
            onChange={(e) => setCode(filterCode(e.target.value))}
            placeholder="K7QX2M"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-describedby="join-code-hint"
          />
          <p id="join-code-hint" className="mt-1 text-xs tabular-nums text-zinc-500">
            {code.length}/{ROOM_CODE_LENGTH}
          </p>
        </div>
        <div>
          <label htmlFor="join-nick" className="label">
            Your name
          </label>
          <input
            id="join-nick"
            className="field"
            value={nickname}
            maxLength={NICKNAME_MAX}
            autoComplete="nickname"
            onChange={(e) => setNickname(e.target.value)}
            placeholder="e.g. Ben"
          />
        </div>
      </div>
      <button type="submit" className="btn-ghost mt-6 w-full py-3 text-[15px]" disabled={!valid}>
        Join room
      </button>
    </form>
  );
}
