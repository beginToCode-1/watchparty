'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { MEDIA_URL_MAX, NICKNAME_MAX } from '@watchparty/shared-types';
import { classifyMediaUrl } from '@watchparty/sync-engine/classify';
import { RoomError, createRoom, errorText } from '@/lib/socket';
import { readNickname, writePref } from '@/lib/util';
import { ModeBadge, Spinner } from './ModeBadge';

export function CreateRoomForm() {
  const router = useRouter();
  const [nickname, setNickname] = useState('');
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = url.trim() ? classifyMediaUrl(url) : null;
  // blob:/file: links mean nothing to other peers; local files are picked inside the room.
  const urlInvalid = url.trim().length > 0 && (!info || info.kind === 'local');

  useEffect(() => setNickname((n) => n || readNickname()), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const nick = nickname.trim();
    if (!nick || urlInvalid) return;
    setPending(true);
    setError(null);
    writePref('wp:nickname', nick);
    try {
      const code = await createRoom(nick, info?.url);
      router.push(`/room/${code}`);
    } catch (err: unknown) {
      setError(err instanceof RoomError ? errorText(err) : 'Could not create the room.');
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="material-thick animate-materialize rounded-3xl p-6 sm:p-7">
      <h2 className="text-xl font-semibold tracking-title">Start a party</h2>
      <p className="mt-1 text-sm text-zinc-400">You&apos;ll be the host. Share the code once you&apos;re in.</p>
      <div className="mt-5 space-y-4">
        <div>
          <label htmlFor="create-nick" className="label">
            Your name
          </label>
          <input
            id="create-nick"
            className="field"
            value={nickname}
            maxLength={NICKNAME_MAX}
            autoComplete="nickname"
            required
            onChange={(e) => setNickname(e.target.value)}
            placeholder="e.g. Ana"
          />
        </div>
        <div>
          <label htmlFor="create-url" className="label">
            Link to watch <span className="normal-case tracking-normal text-zinc-500">(optional)</span>
          </label>
          <input
            id="create-url"
            className="field"
            value={url}
            maxLength={MEDIA_URL_MAX}
            inputMode="url"
            onChange={(e) => setUrl(e.target.value)}
            placeholder="YouTube, .m3u8, .mp4, Netflix, any page…"
            aria-invalid={urlInvalid}
            aria-describedby="create-url-hint"
          />
          <p id="create-url-hint" className="mt-2 min-h-[22px] text-sm" aria-live="polite">
            {urlInvalid ? (
              <span className="text-signal-err">That isn&apos;t a link we can use. Local files are picked inside the room.</span>
            ) : info ? (
              <ModeBadge info={info} />
            ) : null}
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-signal-err">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="btn-primary mt-4 w-full py-3 text-[15px]"
        disabled={pending || !nickname.trim() || urlInvalid}
      >
        {pending ? <Spinner /> : null}
        {pending ? 'Creating…' : 'Create room'}
      </button>
    </form>
  );
}
