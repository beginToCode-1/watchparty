import { DRM_PROVIDERS, MEDIA_URL_MAX, YOUTUBE_ID_REGEX, type MediaInfo } from '@watchparty/shared-types';

const LOCAL_SENTINEL = /^local:([^/\\\u0000-\u001f]{1,255})$/;
const YT_HOST = /^(?:www\.|m\.|music\.)?youtube\.com$/;
const YT_PATH = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/;
const YT_SHORT_PATH = /^\/([A-Za-z0-9_-]{11})(?:\/|$)/;
const HLS_PATH = /\.m3u8$/i;
const HLS_MIME = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl']);
const FILE_PATH = /\.(?:mp4|webm|ogg|ogv|mov|m4v|mkv)$/i;

function youtubeId(host: string, url: URL): string | null {
  if (host === 'youtu.be') return YT_SHORT_PATH.exec(url.pathname)?.[1] ?? null;
  if (!YT_HOST.test(host)) return null;
  if (url.pathname === '/watch') {
    const v = url.searchParams.get('v');
    return v !== null && YOUTUBE_ID_REGEX.test(v) ? v : null;
  }
  return YT_PATH.exec(url.pathname)?.[1] ?? null;
}

/**
 * Classifies a media link (docs/WEBRTC_AND_MEDIA.md §1). Pure, synchronous, no DOM.
 * Invalid input returns `null` and never throws (docs/CODING_CONTRACT.md decision D1); callers map it to INVALID_PAYLOAD.
 * `contentType` (optional) upgrades an extensionless URL to `hls` when it is an HLS MIME type.
 */
export function classifyMediaUrl(input: string, contentType?: string): MediaInfo | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.length < 1 || s.length > MEDIA_URL_MAX) return null;
  if (LOCAL_SENTINEL.test(s)) return { kind: 'local', mode: 'A', url: s };

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol === 'blob:' || url.protocol === 'file:') return { kind: 'local', mode: 'A', url: url.href };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase();
  const ytId = youtubeId(host, url);
  if (ytId) return { kind: 'youtube', mode: 'A', url: url.href, youtubeId: ytId };

  for (const p of DRM_PROVIDERS) {
    if (!p.host.test(host)) continue;
    if ('pathPrefix' in p && !url.pathname.startsWith(p.pathPrefix)) continue;
    return { kind: 'drm', mode: 'B', url: url.href, provider: p.key };
  }

  const mime = contentType?.split(';')[0]?.trim().toLowerCase();
  if (HLS_PATH.test(url.pathname) || (mime !== undefined && HLS_MIME.has(mime))) {
    return { kind: 'hls', mode: 'A', url: url.href };
  }
  if (FILE_PATH.test(url.pathname)) return { kind: 'file', mode: 'A', url: url.href };
  return { kind: 'unknown', mode: 'C', url: url.href };
}
