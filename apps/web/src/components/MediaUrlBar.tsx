'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { MEDIA_URL_MAX, QUEUE_TITLE_MAX, metadataSchema, type Metadata } from '@watchparty/shared-types';
import { classifyMediaUrl } from '@watchparty/sync-engine/classify';
import { act } from '@/lib/socket';
import { safeHttpUrl, serverUrl } from '@/lib/util';
import { canControl, useRoom } from '@/store/room';
import { ModeBadge } from './ModeBadge';

const PREVIEW_DEBOUNCE_MS = 400;

/** Paste a link → classification badge + metadata preview → Load now / Add to queue; or pick a local file. */
export function MediaUrlBar() {
  const control = useRoom(canControl);
  const [url, setUrl] = useState('');
  const [meta, setMeta] = useState<Metadata | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = url.trim();
  const info = trimmed ? classifyMediaUrl(trimmed) : null;
  const usable = !!info && info.kind !== 'local';

  useEffect(() => {
    setMeta(null);
    const target = trimmed ? classifyMediaUrl(trimmed) : null;
    if (!target || target.kind === 'local') return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`${serverUrl()}/api/metadata?${new URLSearchParams({ url: target.url }).toString()}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((json: unknown) => {
          const parsed = metadataSchema.safeParse(json);
          if (parsed.success) setMeta(parsed.data);
        })
        .catch(() => {
          // Metadata is decoration only; the link still works without it.
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [trimmed]);

  async function run(kind: 'load' | 'queue') {
    if (!info || !usable) return;
    setBusy(true);
    const title = meta?.title?.slice(0, QUEUE_TITLE_MAX);
    const ok =
      kind === 'load'
        ? await act('player:load', { mediaUrl: info.url })
        : await act('queue:add', title ? { mediaUrl: info.url, title } : { mediaUrl: info.url });
    setBusy(false);
    if (ok) setUrl('');
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(control ? 'load' : 'queue');
  }

  const image = safeHttpUrl(meta?.image);

  return (
    <form onSubmit={submit} className="material rounded-2xl p-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="media-url" className="sr-only">
          Media link
        </label>
        <input
          id="media-url"
          className="field min-w-[200px] flex-1 border-transparent bg-black/25"
          value={url}
          maxLength={MEDIA_URL_MAX}
          inputMode="url"
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a YouTube, .m3u8, .mp4, Netflix or any page link"
        />
        <button type="submit" className="btn-primary" disabled={!usable || busy || !control}>
          Play now
        </button>
        <button type="button" className="btn-ghost" disabled={!usable || busy} onClick={() => void run('queue')}>
          + Queue
        </button>
        <label className={`btn-ghost cursor-pointer ${control ? '' : 'pointer-events-none opacity-40'}`} aria-disabled={!control}>
          Local file
          <input
            type="file"
            accept="video/*,.mkv"
            className="sr-only"
            disabled={!control}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              useRoom.setState({ localFile: f });
              void act('player:load', { mediaUrl: `local:${f.name.replace(/[/\\\u0000-\u001f]/g, '_').slice(0, 255)}` });
            }}
          />
        </label>
      </div>
      {trimmed && (
        <div className="flex items-center gap-3 px-2 pb-1 pt-2 text-sm" aria-live="polite">
          {!usable ? (
            <span className="text-signal-err">That isn&apos;t a link we can use.</span>
          ) : (
            <>
              {image && (
                <img src={image} alt="" referrerPolicy="no-referrer" loading="lazy" className="h-9 w-16 rounded-md object-cover" />
              )}
              <div className="min-w-0 flex-1">
                {meta?.title && <p className="truncate font-medium text-zinc-200">{meta.title}</p>}
                {meta?.siteName && <p className="truncate text-xs text-zinc-500">{meta.siteName}</p>}
              </div>
              {info && <ModeBadge info={info} />}
            </>
          )}
        </div>
      )}
      {!control && <p className="px-2 pb-1 pt-1 text-xs text-zinc-500">The host controls playback — you can still add to the queue.</p>}
    </form>
  );
}
