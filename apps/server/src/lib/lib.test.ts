import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROOM_CODE_REGEX } from '@watchparty/shared-types';
import { decodeEntities, isPublicAddress, parseHtmlMeta } from './metadata.js';
import { KeyedLimiter, clientIp, createSocketLimiter, ipKey, proxyList, take } from './rateLimit.js';
import { generateRoomCode } from './roomCode.js';
import { sanitizeChat, sanitizeNickname, sanitizeText } from './sanitize.js';
import { extractTimestamps } from './timestamps.js';
import { turnCredentials } from './turn.js';

test('token bucket: burst, refill, no overfill', () => {
  const b = { tokens: 5, last: 0 };
  for (let i = 0; i < 5; i++) assert.equal(take(b, 5, 5000, 0), true);
  assert.equal(take(b, 5, 5000, 0), false); // 6th within the window
  assert.equal(take(b, 5, 5000, 999), false); // 0.999 tokens
  assert.equal(take(b, 5, 5000, 1000), true); // 1 token per second
  assert.equal(take(b, 5, 5000, 1_000_000), true);
  assert.ok(b.tokens <= 4); // capped at capacity before the take
});

test('socket limiter: chat 5/5s, buckets independent', () => {
  let now = 0;
  const limit = createSocketLimiter(() => now);
  for (let i = 0; i < 5; i++) assert.equal(limit('chat'), true);
  assert.equal(limit('chat'), false);
  assert.equal(limit('reaction'), true);
  now = 1000;
  assert.equal(limit('chat'), true);
  assert.equal(limit('chat'), false);
});

test('keyed limiter returns Retry-After seconds', () => {
  const l = new KeyedLimiter(10, 60_000);
  for (let i = 0; i < 10; i++) assert.equal(l.take('ip', 0), 0);
  assert.equal(l.take('ip', 0), 6); // 1 token per 6 s
  assert.equal(l.take('other', 0), 0);
});

test('client IP and rate-limit key', () => {
  const loopback = proxyList(['127.0.0.1/8', '::1/128']); // TRUSTED_PROXIES default
  assert.equal(clientIp('::ffff:203.0.113.9', '1.2.3.4', loopback), '203.0.113.9'); // public peer: XFF ignored
  assert.equal(clientIp('127.0.0.1', '198.51.100.7, 10.0.0.1', loopback), '198.51.100.7'); // our proxy: first hop
  assert.equal(clientIp('::ffff:127.0.0.1', '198.51.100.7', loopback), '198.51.100.7');
  assert.equal(clientIp('192.168.1.5', '1.2.3.4', loopback), '192.168.1.5'); // LAN / Docker peer: no spoofing by default
  assert.equal(clientIp('172.30.0.9', '1.2.3.4', proxyList(['172.30.0.0/24'])), '1.2.3.4'); // compose nginx when listed
  assert.equal(clientIp('127.0.0.1', 'garbage', loopback), '127.0.0.1');
  for (const bad of ['10.0.0.0/', '10.0.0.0/33', 'nope', '::1/129', '1.2.3.4/8/1']) assert.throws(() => proxyList([bad]), bad);
  assert.equal(ipKey('8.8.8.8'), '8.8.8.8');
  assert.equal(ipKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8::1'), '2001:db8:0:0::/64');
});

test('room codes use the alphabet', () => {
  const codes = new Set(Array.from({ length: 2000 }, generateRoomCode));
  for (const c of codes) assert.match(c, ROOM_CODE_REGEX);
  assert.ok(codes.size > 1990);
});

test('sanitize', () => {
  assert.equal(sanitizeText('‮evil\u0007 \r\nname '), 'evil   name');
  assert.equal(sanitizeNickname('\u0000\u0001'), null);
  assert.equal(sanitizeNickname('a'.repeat(25)), null);
  assert.equal(sanitizeChat('<b>hi</b>'), '<b>hi</b>');
  assert.equal(sanitizeText('👨‍👩'), '👨‍👩'); // ZWJ kept
});

test('chat timestamp tags', () => {
  assert.deepEqual(extractTimestamps('look at @1:02:03 and @12:34'), [3723, 754]);
  assert.deepEqual(extractTimestamps('@0:05!'), [5]);
  for (const s of ['mail me@1:00', '@1:2', '@1:60', '@12:34:5']) assert.deepEqual(extractTimestamps(s), []);
  assert.equal(extractTimestamps(Array(11).fill('@0:01').join(' ')).length, 10);
});

test('TURN credentials: coturn REST vector and STUN-only', () => {
  const r = turnCredentials({ secret: 'test-secret', userId: 'user-1', turnUrls: ['turn:t'], stunUrls: ['stun:s'], nowMs: 0 });
  assert.equal(r.ttl, 3600);
  assert.deepEqual(r.iceServers[1], { urls: ['turn:t'], username: '3600:user-1', credential: 'fWE4kEwfRRPv7T1LE9L6b01x7Zs=' });
  assert.deepEqual(turnCredentials({ secret: '', userId: 'u', turnUrls: ['turn:t'], stunUrls: ['stun:s'] }).iceServers, [
    { urls: ['stun:s'] },
  ]);
});

test('SSRF address guard', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'not-an-ip']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
});

test('OpenGraph parsing', () => {
  const html = `<html><head><title>Fallback &amp; co</title>
    <meta property="og:title" content="Big &quot;Movie&quot;">
    <meta content='A &#x27;great&#39; film' name="description">
    <meta property="og:image" content="/poster.jpg"><meta property="og:site_name" content="Site‮">
    </head><body><meta property="og:title" content="ignored"></body></html>`;
  assert.deepEqual(parseHtmlMeta(html, new URL('https://example.com/watch/1')), {
    title: 'Big "Movie"',
    description: "A 'great' film",
    image: 'https://example.com/poster.jpg',
    siteName: 'Site',
  });
  assert.equal(parseHtmlMeta('<title>T</title>', new URL('https://www.ex.org/')).siteName, 'ex.org');
  assert.equal(decodeEntities('&#0;&bogus;&lt;'), '&#0;&bogus;<');
});
