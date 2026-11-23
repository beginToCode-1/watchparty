'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { NICKNAME_MAX, type ErrorCode } from '@watchparty/shared-types';
import { errorText } from '@/lib/socket';
import { readNickname, writePref } from '@/lib/util';
import { Spinner } from './ModeBadge';

const FATAL: ErrorCode[] = ['ROOM_NOT_FOUND', 'ROOM_FULL', 'TOO_MANY_ATTEMPTS'];

export function NicknameGate({
  code,
  pending,
  error,
  onJoin,
}: {
  code: string;
  pending: boolean;
  error: { code: ErrorCode; message: string } | null;
  onJoin: (nickname: string) => void;
}) {
  const [nickname, setNickname] = useState('');
  useEffect(() => setNickname((n) => n || readNickname()), []);
  const fatal = error !== null && FATAL.includes(error.code);

  function submit(e: FormEvent) {
    e.preventDefault();
    const nick = nickname.trim();
    if (!nick) return;
    writePref('wp:nickname', nick);
    onJoin(nick);
  }

  return (
    <main className="grid min-h-[75dvh] place-items-center px-4">
      <form onSubmit={submit} className="material-thick animate-materialize w-full max-w-sm rounded-3xl p-7">
        <p className="label">You&apos;re invited to</p>
        <h1 className="font-mono text-3xl font-bold tracking-[0.25em]">{code}</h1>
        {!fatal && (
          <>
            <label htmlFor="gate-nick" className="label mt-6">
              Your name
            </label>
            <input
              id="gate-nick"
              className="field"
              value={nickname}
              maxLength={NICKNAME_MAX}
              autoComplete="nickname"
              autoFocus
              onChange={(e) => setNickname(e.target.value)}
              placeholder="e.g. Ben"
            />
          </>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-signal-err">
            {errorText(error)}
          </p>
        )}
        {fatal ? (
          <Link href="/" className="btn-primary mt-6 w-full py-3">
            Back to start
          </Link>
        ) : (
          <button type="submit" className="btn-primary mt-6 w-full py-3 text-[15px]" disabled={pending || !nickname.trim()}>
            {pending ? <Spinner /> : null}
            {pending ? 'Joining…' : 'Join the party'}
          </button>
        )}
      </form>
    </main>
  );
}
