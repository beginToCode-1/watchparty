import { BlockList, isIP } from 'node:net';
import { RATE_LIMITS } from '@watchparty/shared-types';

export type BucketName = keyof typeof RATE_LIMITS;

export interface Bucket {
  tokens: number;
  last: number;
}

/** Token bucket: `capacity` burst, refilled linearly at `capacity / windowMs` tokens per ms. */
export function take(b: Bucket, capacity: number, windowMs: number, now = Date.now()): boolean {
  b.tokens = Math.min(capacity, b.tokens + Math.max(0, now - b.last) * (capacity / windowMs));
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Per-socket buckets, created full on first use. */
export function createSocketLimiter(now: () => number = Date.now) {
  const buckets = new Map<BucketName, Bucket>();
  return (name: BucketName): boolean => {
    const { capacity, windowMs } = RATE_LIMITS[name];
    let b = buckets.get(name);
    if (!b) buckets.set(name, (b = { tokens: capacity, last: now() }));
    return take(b, capacity, windowMs, now());
  };
}

const IDLE_MS = 10 * 60_000;

/** Per-key (IP) buckets for HTTP routes; idle entries are pruned lazily. */
export class KeyedLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
  ) {}

  /** Returns 0 when allowed, otherwise the seconds until one token is available (for Retry-After). */
  take(key: string, now = Date.now()): number {
    if (now - this.lastSweep > 60_000) {
      this.lastSweep = now;
      for (const [k, b] of this.buckets) if (now - b.last > IDLE_MS) this.buckets.delete(k);
    }
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { tokens: this.capacity, last: now }));
    if (take(b, this.capacity, this.windowMs, now)) return 0;
    return Math.max(1, Math.ceil(((1 - b.tokens) * this.windowMs) / this.capacity / 1000));
  }
}

const unmap = (ip: string) => (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip) ? ip.slice(7) : ip);

/** TRUSTED_PROXIES entries (IPs or CIDRs) as a BlockList; throws on a malformed entry. */
export function proxyList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const e of entries) {
    const [addr = '', bits, extra] = e.split('/');
    const family = isIP(addr);
    const max = family === 4 ? 32 : 128;
    const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : -1;
    if (!family || extra !== undefined || prefix < 0 || prefix > max) throw new Error(`invalid IP/CIDR "${e}"`);
    list.addSubnet(addr, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

/** Peer is one of our reverse proxies. Shared by the socket layer and Fastify's `trustProxy`. */
export function isTrusted(trusted: BlockList, ip: string): boolean {
  const a = unmap(ip);
  const family = isIP(a);
  return family !== 0 && trusted.check(a, family === 4 ? 'ipv4' : 'ipv6');
}

/** Client IP: the TCP peer, or the first X-Forwarded-For hop only when the peer is a trusted proxy (our nginx). */
export function clientIp(peer: string, xff: string | string[] | undefined, trusted: BlockList): string {
  const direct = unmap(peer);
  if (!isTrusted(trusted, direct)) return direct;
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first && isIP(unmap(first)) ? unmap(first) : direct;
}

/** Rate-limit key: full IPv4, IPv6 collapsed to its /64 (one host usually owns the whole /64). */
export function ipKey(ip: string): string {
  const a = unmap(ip).toLowerCase();
  if (isIP(a) !== 6) return a;
  const [head = '', tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}
