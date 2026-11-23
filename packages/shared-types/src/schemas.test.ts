import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  chatSendSchema,
  DRM_PROVIDERS,
  externalMessageSchema,
  filterCode,
  nicknameSchema,
  parseBridgeReply,
  PROVIDER_MATCHES,
  playbackStateSchema,
  playerPlaySchema,
  playerRateSchema,
  REACTION_EMOJIS,
  reactionSendSchema,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  roomCodeSchema,
  roomJoinSchema,
  rtcOfferSchema,
} from './index.js';

const UUID = '2b0c8f5e-5b1d-4a5e-9a0e-3f0e7d1c9a11';

test('constants', () => {
  assert.equal(REACTION_EMOJIS.length, 12);
  assert.equal(ROOM_CODE_ALPHABET.length, 32);
  assert.equal(ROOM_CODE_LENGTH, 6);
  assert.doesNotMatch(ROOM_CODE_ALPHABET, /[0O1I]/);
  assert.equal(DRM_PROVIDERS.length, 14);
  assert.ok(PROVIDER_MATCHES.includes('https://*.netflix.com/*'));
  assert.ok(PROVIDER_MATCHES.includes('https://www.amazon.com.mx/gp/video/*'));
  const amazon = DRM_PROVIDERS.find((p) => p.key === 'amazon');
  assert.ok(amazon);
  assert.equal(amazon.matches.length, 12);
  for (const h of ['www.amazon.co.uk', 'smile.amazon.de', 'amazon.com.au']) assert.match(h, amazon.host);
  for (const h of ['amazon.coxuk', 'evil.amazon.com', 'amazon.com.evil']) assert.doesNotMatch(h, amazon.host);
  assert.equal(filterCode(' k7q-x2m0o99 '), 'K7QX2M');
});

test('parseBridgeReply', () => {
  const data = z.object({ tabId: z.number() });
  assert.deepEqual(parseBridgeReply({ ok: true, data: { tabId: 1 } }, data), { ok: true, data: { tabId: 1 } });
  assert.equal(parseBridgeReply({ ok: true, data: {} }, data), null);
  assert.equal(parseBridgeReply('nope', data), null);
  assert.equal(parseBridgeReply({ ok: false }, data), null);
  assert.deepEqual(parseBridgeReply({ ok: false, error: { code: 'NO_SESSION', message: 'x' } }, data), {
    ok: false,
    error: { code: 'NO_SESSION', message: 'x' },
  });
  assert.deepEqual(parseBridgeReply({ ok: false, error: {} }, data), {
    ok: false,
    error: { code: 'TAB_ERROR', message: 'The extension refused the request' },
  });
});

test('room code is trimmed, upper-cased and alphabet-checked', () => {
  assert.equal(roomCodeSchema.parse(' abc23k '), 'ABC23K');
  assert.equal(roomCodeSchema.parse('k7qx2m'), 'K7QX2M');
  assert.equal(roomCodeSchema.safeParse('ABC10K').success, false);
  assert.equal(roomCodeSchema.safeParse('O0I1AA').success, false);
  assert.equal(roomCodeSchema.safeParse('ABC23').success, false);
});

test('text limits', () => {
  assert.equal(nicknameSchema.safeParse('a'.repeat(24)).success, true);
  assert.equal(nicknameSchema.safeParse('a'.repeat(25)).success, false);
  assert.equal(nicknameSchema.safeParse('   ').success, false);
  assert.equal(chatSendSchema.safeParse({ text: 'x'.repeat(500) }).success, true);
  assert.equal(chatSendSchema.safeParse({ text: 'x'.repeat(501) }).success, false);
});

test('numbers', () => {
  for (const position of [-0.1, Number.NaN, Number.POSITIVE_INFINITY, 86_401]) {
    assert.equal(playerPlaySchema.safeParse({ position }).success, false, String(position));
  }
  assert.equal(playerPlaySchema.safeParse({ position: 12.5 }).success, true);
  assert.equal(playerRateSchema.safeParse({ rate: 2 }).success, true);
  assert.equal(playerRateSchema.safeParse({ rate: 2.01 }).success, false);
  assert.equal(playerRateSchema.safeParse({ rate: 0.24 }).success, false);
});

test('emoji allowlist', () => {
  assert.equal(reactionSendSchema.safeParse({ emoji: '🔥' }).success, true);
  assert.equal(reactionSendSchema.safeParse({ emoji: '🤡' }).success, false);
});

test('unknown keys are stripped, not rejected', () => {
  assert.deepEqual(roomJoinSchema.parse({ roomCode: 'abc23k', nickname: ' Ann ', extra: 1 }), {
    roomCode: 'ABC23K',
    nickname: 'Ann',
  });
});

test('rtc target must be a uuid', () => {
  assert.equal(rtcOfferSchema.safeParse({ to: UUID, sdp: 'v=0' }).success, true);
  assert.equal(rtcOfferSchema.safeParse({ to: 'nope', sdp: 'v=0' }).success, false);
  assert.equal(rtcOfferSchema.safeParse({ to: UUID, sdp: 'x'.repeat(32_769) }).success, false);
});

test('playback state', () => {
  const state = {
    mediaUrl: null,
    mode: null,
    kind: null,
    paused: true,
    position: 0,
    rate: 1,
    updatedAt: Date.now(),
    seq: 0,
    byUserId: null,
  };
  assert.equal(playbackStateSchema.safeParse(state).success, true);
  assert.equal(playbackStateSchema.safeParse({ ...state, seq: -1 }).success, false);
});

test('extension bridge handoff accepts only http(s) media', () => {
  const base = { type: 'WP_HANDOFF', roomCode: 'abc23k', nickname: 'Ann' };
  assert.equal(externalMessageSchema.safeParse({ ...base, mediaUrl: 'https://www.netflix.com/watch/1' }).success, true);
  for (const mediaUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'not a url']) {
    assert.equal(externalMessageSchema.safeParse({ ...base, mediaUrl }).success, false, mediaUrl);
  }
  assert.equal(externalMessageSchema.safeParse({ type: 'WP_PING' }).success, true);
  assert.equal(externalMessageSchema.safeParse({ type: 'WP_NOPE' }).success, false);
});
