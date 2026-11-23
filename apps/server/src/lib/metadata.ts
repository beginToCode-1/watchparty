import { lookup } from 'node:dns/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import type { MediaInfo, Metadata } from '@watchparty/shared-types';
import { classifyMediaUrl } from '@watchparty/sync-engine/classify';
import { sanitizeText } from './sanitize.js';

// ---------- SSRF guard ----------

const BLOCK = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCK.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) BLOCK.addSubnet(net, prefix, 'ipv6');

/** BlockList checks IPv4-mapped IPv6 (`::ffff:a.b.c.d` / `::ffff:7f00:1`) against the IPv4 rules itself. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  return family !== 0 && !BLOCK.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** Target refused by the SSRF policy (scheme, port, credentials or a non-public address). */
export class BlockedTargetError extends Error {}

interface Target {
  address: string;
  family: number;
}

async function resolveTarget(url: URL): Promise<Target> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedTargetError('scheme');
  if (url.username || url.password) throw new BlockedTargetError('credentials');
  if (url.port !== '' && url.port !== '80' && url.port !== '443') throw new BlockedTargetError('port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  if (literal) {
    if (!isPublicAddress(host)) throw new BlockedTargetError('address');
    return { address: host, family: literal };
  }
  const addrs = await lookup(host, { all: true, verbatim: true });
  const first = addrs[0];
  if (!first || addrs.some((a) => !isPublicAddress(a.address))) throw new BlockedTargetError('address');
  return first;
}

const MAX_REDIRECTS = 3;
const HEADER_TIMEOUT_MS = 3_000;
const BASE_HEADERS = {
  'User-Agent': 'WatchPartyBot/1.0 (+metadata)',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
  'Accept-Encoding': 'identity', // no decompression => no zip bombs
  'Accept-Language': 'en',
};

interface FetchOptions {
  method: 'GET' | 'HEAD';
  timeoutMs: number;
  maxBytes: number;
  stopAtHeadEnd?: boolean;
  headers?: Record<string, string>;
}

interface FetchResult {
  status: number;
  contentType: string | null;
  body: Buffer;
  finalUrl: URL;
}

function send(url: URL, target: Target, opts: FetchOptions, signal: AbortSignal): Promise<IncomingMessage> {
  const secure = url.protocol === 'https:';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    // Connect to the validated address itself (defeats DNS rebinding); Host header + SNI keep the real name.
    const req = (secure ? https : http).request(
      {
        host: target.address,
        family: target.family,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        servername: isIP(host) ? undefined : host,
        headers: { ...BASE_HEADERS, ...opts.headers, Host: url.host },
        agent: false,
        signal,
      },
      resolve,
    );
    req.setTimeout(HEADER_TIMEOUT_MS, () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

function readBody(res: IncomingMessage, maxBytes: number, stopAtHeadEnd: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = () => resolve(Buffer.concat(chunks, size));
    if (maxBytes <= 0) {
      res.destroy();
      return finish();
    }
    res.on('data', (chunk: Buffer) => {
      const part = chunk.subarray(0, maxBytes - size);
      chunks.push(part);
      size += part.length;
      if (size >= maxBytes || (stopAtHeadEnd && /<\/head\s*>/i.test(part.toString('latin1')))) {
        res.destroy();
        finish();
      }
    });
    res.on('end', finish);
    res.on('close', finish); // aborted mid-body: keep what arrived
    res.on('error', reject);
  });
}

async function safeFetch(rawUrl: string, opts: FetchOptions): Promise<FetchResult> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let url = new URL(rawUrl);
  for (let hop = 0; ; hop++) {
    const target = await resolveTarget(url);
    const res = await send(url, target, opts, signal);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.destroy();
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      url = new URL(location, url); // re-validated by resolveTarget on the next hop
      continue;
    }
    const body = await readBody(res, opts.maxBytes, opts.stopAtHeadEnd ?? false);
    return { status, contentType: res.headers['content-type'] ?? null, body, finalUrl: url };
  }
}

// ---------- small TTL + LRU cache (Map insertion order) ----------

const CACHE_MAX = 500;
const CACHE_TTL_MS = 10 * 60_000;

class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    if (hit.expires < Date.now()) return undefined;
    this.map.set(key, hit);
    return hit.value;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    const oldest = this.map.keys().next();
    if (this.map.size > CACHE_MAX && !oldest.done) this.map.delete(oldest.value);
  }
}

// ---------- HTML meta parsing ----------

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m;
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

function clean(s: string | undefined, max: number): string | null {
  if (s === undefined) return null;
  const v = sanitizeText(decodeEntities(s)).replace(/\s+/g, ' ').slice(0, max).trim();
  return v || null;
}

function httpUrl(raw: string | undefined, base: URL): string | null {
  const u = raw ? URL.parse(decodeEntities(raw).trim(), base.href) : null;
  return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
}

const hostLabel = (u: URL) => u.hostname.replace(/^www\./, '');

// ponytail: regex <meta>/<title> parsing; swap for an HTML parser if sites with odd markup matter.
export function parseHtmlMeta(html: string, baseUrl: URL): Pick<Metadata, 'title' | 'description' | 'image' | 'siteName'> {
  const end = html.search(/<\/head\s*>/i);
  const head = end === -1 ? html : html.slice(0, end);
  const meta = new Map<string, string>();
  for (const [tag] of head.matchAll(/<meta\s+[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs.set((a[1] ?? '').toLowerCase(), a[3] ?? a[4] ?? a[5] ?? '');
    }
    const key = (attrs.get('property') ?? attrs.get('name'))?.toLowerCase();
    const content = attrs.get('content');
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1];
  return {
    title: clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag, 200),
    description: clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), 500),
    image:
      httpUrl(meta.get('og:image:secure_url'), baseUrl) ??
      httpUrl(meta.get('og:image'), baseUrl) ??
      httpUrl(meta.get('twitter:image'), baseUrl),
    siteName: clean(meta.get('og:site_name') ?? meta.get('application-name'), 100) ?? hostLabel(baseUrl),
  };
}

function decoderFor(contentType: string | null) {
  try {
    return new TextDecoder(/charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1]);
  } catch {
    return new TextDecoder(); // unknown charset label: utf-8
  }
}

function lastPathSegment(rawUrl: string): string | null {
  const seg = URL.parse(rawUrl)?.pathname.split('/').filter(Boolean).pop();
  if (!seg) return null;
  try {
    return clean(decodeURIComponent(seg), 200);
  } catch {
    return clean(seg, 200);
  }
}

// ---------- public API ----------

const PAGE_MAX_BYTES = 512 * 1024;
const PAGE_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_000;

const metadataCache = new TtlCache<Metadata>();
const probeCache = new TtlCache<string | null>();

const oembedSchema = z.object({
  title: z.string().optional(),
  author_name: z.string().optional(),
  thumbnail_url: z.string().optional(),
});

const nulls = { title: null, description: null, image: null, siteName: null };

async function youtubeMetadata(info: MediaInfo): Promise<Metadata> {
  const id = info.youtubeId ?? '';
  const fallback: Metadata = {
    ...nulls,
    image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    siteName: 'YouTube',
    kind: info.kind,
    mode: info.mode,
  };
  const watch = `https://www.youtube.com/watch?v=${id}`;
  try {
    const res = await safeFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, {
      method: 'GET',
      timeoutMs: PAGE_TIMEOUT_MS,
      maxBytes: 64 * 1024,
      headers: { Accept: 'application/json' },
    });
    if (res.status !== 200) return fallback;
    const parsed = oembedSchema.safeParse(JSON.parse(res.body.toString('utf8')));
    if (!parsed.success) return fallback;
    const base = new URL(watch);
    return {
      title: clean(parsed.data.title, 200),
      description: clean(parsed.data.author_name, 500),
      image: httpUrl(parsed.data.thumbnail_url, base) ?? fallback.image,
      siteName: 'YouTube',
      kind: info.kind,
      mode: info.mode,
    };
  } catch (err: unknown) {
    if (err instanceof BlockedTargetError) throw err;
    return fallback;
  }
}

async function pageMetadata(info: MediaInfo): Promise<Metadata> {
  const base: Metadata = { ...nulls, kind: info.kind, mode: info.mode };
  let res: FetchResult;
  try {
    res = await safeFetch(info.url, {
      method: 'GET',
      timeoutMs: PAGE_TIMEOUT_MS,
      maxBytes: PAGE_MAX_BYTES,
      stopAtHeadEnd: true,
    });
  } catch (err: unknown) {
    if (err instanceof BlockedTargetError) throw err;
    return base; // upstream failures are decoration-only: 200 with nulls
  }
  if (res.status < 200 || res.status >= 300) return base;
  const ct = res.contentType ?? '';
  if (!/^\s*(text\/html|application\/xhtml\+xml)/i.test(ct)) {
    const re = classifyMediaUrl(info.url, ct) ?? info;
    return { ...nulls, title: lastPathSegment(info.url), kind: re.kind, mode: re.mode };
  }
  const html = decoderFor(ct).decode(res.body);
  return { ...parseHtmlMeta(html, res.finalUrl), kind: info.kind, mode: info.mode };
}

/**
 * OpenGraph / oEmbed metadata for an already-classified URL. Throws BlockedTargetError when the SSRF policy refuses
 * the target (including any redirect hop); every other upstream failure yields 200-style nulls.
 */
export async function fetchMetadata(info: MediaInfo): Promise<Metadata> {
  const cached = metadataCache.get(info.url);
  if (cached) return cached;
  let result: Metadata;
  switch (info.kind) {
    case 'local':
      result = { ...nulls, title: clean(/^local:(.+)$/.exec(info.url)?.[1], 200), kind: info.kind, mode: info.mode };
      break;
    case 'youtube':
      result = await youtubeMetadata(info);
      break;
    case 'hls':
    case 'file':
      result = { ...nulls, title: lastPathSegment(info.url), kind: info.kind, mode: info.mode };
      break;
    case 'drm':
    case 'unknown':
      result = await pageMetadata(info);
      break;
  }
  metadataCache.set(info.url, result);
  return result;
}

export function cachedTitle(url: string): string | null {
  return metadataCache.get(url)?.title ?? null;
}

/** Content-Type of a URL via HEAD (ranged GET fallback); null when unreachable or blocked. Cached 10 min. */
async function probeContentType(url: string): Promise<string | null> {
  const cached = probeCache.get(url);
  if (cached !== undefined) return cached;
  let ct: string | null = null;
  try {
    const head = await safeFetch(url, { method: 'HEAD', timeoutMs: PROBE_TIMEOUT_MS, maxBytes: 0 });
    ct = head.status < 400 ? head.contentType : null;
    if (!ct) {
      const get = await safeFetch(url, {
        method: 'GET',
        timeoutMs: PROBE_TIMEOUT_MS,
        maxBytes: 1,
        headers: { Range: 'bytes=0-0' },
      });
      ct = get.status < 400 ? get.contentType : null;
    }
  } catch {
    ct = null;
  }
  probeCache.set(url, ct);
  return ct;
}

/** classifyMediaUrl, upgrading `unknown` via a Content-Type probe (extensionless HLS). null = invalid URL. */
export async function classifyWithProbe(url: string): Promise<MediaInfo | null> {
  const info = classifyMediaUrl(url);
  if (!info || info.kind !== 'unknown') return info;
  const ct = await probeContentType(info.url);
  return (ct && classifyMediaUrl(info.url, ct)) || info;
}
