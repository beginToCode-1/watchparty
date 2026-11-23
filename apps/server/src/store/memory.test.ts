import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ChatMessage, PlaybackState } from '@watchparty/shared-types';
import {
  applyBuffering,
  applyIntent,
  applyLoad,
  emptyBuffer,
  newEffects,
  onWaitTimeout,
  releaseBuffering,
  resolveOverdue,
} from '../socket/handlers/player.js';
import { MemoryStore } from './memory.js';
import { AppError, type ParticipantRecord, type RoomRecord } from './types.js';

const media = { audio: false, video: false, screen: false };
const person = (id: string, joinedAt: number): ParticipantRecord => ({ id, nickname: id, joinedAt, media });
const state = (p: Partial<PlaybackState> = {}): PlaybackState => ({
  mediaUrl: 'https://cdn.example.com/a.mp4', mode: 'A', kind: 'file', paused: true, position: 0, rate: 1,
  updatedAt: 0, seq: 0, byUserId: null, ...p,
});
const room = (code: string, p: Partial<PlaybackState> = {}): RoomRecord => ({
  meta: { code, hostId: 'h', hostOnlyControl: false },
  state: state(p),
  buffer: emptyBuffer(),
});

test('memory store: create collision, participants, cap, TTL expiry', async () => {
  let now = 1_000;
  const s = new MemoryStore(60, () => now);
  assert.equal(await s.createRoom(room('ABCDEF'), person('h', 1)), true);
  assert.equal(await s.createRoom(room('ABCDEF'), person('x', 1)), false);
  assert.equal(await s.addParticipant('ABCDEF', person('b', 0), 2), 'ok');
  assert.equal(await s.addParticipant('ABCDEF', person('c', 3), 2), 'full');
  assert.equal(await s.addParticipant('ZZZZZZ', person('c', 3), 2), 'not_found');
  assert.deepEqual((await s.listParticipants('ABCDEF')).map((p) => p.id), ['b', 'h']); // by joinedAt
  now += 59_000;
  assert.equal(await s.touch('ABCDEF'), true); // activity refreshes the TTL
  now += 59_000;
  assert.ok(await s.getRoom('ABCDEF'));
  now += 61_000;
  assert.equal(await s.getRoom('ABCDEF'), null);
  await s.close();
});

test('memory store: mutateRoom is atomic and aborts on throw', async () => {
  const s = new MemoryStore(60);
  await s.createRoom(room('ABCDEF'), person('h', 1));
  const res = await s.mutateRoom('ABCDEF', (r) => {
    r.state.seq += 1;
    return 'done';
  });
  assert.equal(res?.result, 'done');
  await assert.rejects(
    s.mutateRoom('ABCDEF', (r) => {
      r.state.seq = 99;
      throw new AppError('FORBIDDEN', 'no');
    }),
    AppError,
  );
  assert.equal((await s.getRoom('ABCDEF'))?.state.seq, 1);
  assert.equal(await s.mutateRoom('NOPE22', () => 1), null);
  await s.close();
});

test('memory store: chat trimmed to 200, queue cap and ops, join-failure window', async () => {
  let now = 0;
  const s = new MemoryStore(60, () => now);
  await s.createRoom(room('ABCDEF'), person('h', 1));
  for (let i = 0; i < 205; i++) {
    const msg: ChatMessage = { id: randomUUID(), userId: randomUUID(), nickname: 'n', text: String(i), timestamps: [], at: i };
    await s.appendChat('ABCDEF', msg);
  }
  const last = await s.recentChat('ABCDEF', 500);
  assert.equal(last.length, 200);
  assert.equal(last[0]?.text, '5');
  assert.deepEqual((await s.recentChat('ABCDEF', 2)).map((m) => m.text), ['203', '204']);

  const item = (id: string) => ({ id, mediaUrl: 'u', title: 't', addedBy: 'h', kind: 'file' as const, mode: 'A' as const });
  assert.equal(await s.pushQueue('ABCDEF', item('1'), 2), true);
  assert.equal(await s.pushQueue('ABCDEF', item('2'), 2), true);
  assert.equal(await s.pushQueue('ABCDEF', item('3'), 2), false);
  assert.equal(await s.removeQueue('ABCDEF', '1'), true);
  assert.equal(await s.removeQueue('ABCDEF', '1'), false);
  assert.equal((await s.popQueue('ABCDEF'))?.id, '2');
  assert.equal(await s.popQueue('ABCDEF'), null);

  const k = 'ratelimit:join:1.2.3.4';
  for (let i = 1; i <= 10; i++) assert.equal(await s.incrCounter(k, 600), i);
  await s.decrCounter(k); // refund
  assert.equal(await s.incrCounter(k, 600), 10);
  now += 599_000;
  await s.incrCounter(k, 600); // does not extend the fixed window
  now += 1_000;
  await s.decrCounter(k); // expired: no-op
  assert.equal(await s.incrCounter(k, 600), 1);

  // Empty-room grace TTL.
  await s.expireRoom('ABCDEF', 5);
  now += 5_000;
  assert.equal(await s.getRoom('ABCDEF'), null);
  await s.close();
});

test('playback: mutation table rows bump seq by one', () => {
  const r = room('ABCDEF');
  const fx = newEffects();
  applyIntent(r, { type: 'play', position: 120 }, 'u', 1_000, fx);
  assert.deepEqual([r.state.paused, r.state.position, r.state.seq, r.state.byUserId], [false, 120, 1, 'u']);
  applyIntent(r, { type: 'rate', rate: 1.25 }, 'u', 5_000, fx); // rebase: 120 + 4 s
  assert.deepEqual([r.state.position, r.state.rate, r.state.updatedAt, r.state.seq], [124, 1.25, 5_000, 2]);
  applyIntent(r, { type: 'seek', position: 30 }, 'u', 6_000, fx);
  assert.deepEqual([r.state.paused, r.state.position, r.state.seq], [false, 30, 3]);
  applyIntent(r, { type: 'pause', position: 31 }, 'u', 7_000, fx);
  assert.deepEqual([r.state.paused, r.state.position, r.state.seq], [true, 31, 4]);
  applyLoad(r, { url: 'https://x.test/b.m3u8', kind: 'hls', mode: 'A' }, 'u', 8_000, fx);
  assert.deepEqual([r.state.paused, r.state.position, r.state.rate, r.state.kind, r.state.seq], [true, 0, 1, 'hls', 5]);
});

test('wait-for-buffer: enter, clear with scheduled resume, timeout, ignored, pause cancels', () => {
  const r = room('ABCDEF', { paused: false, position: 10, updatedAt: 0, seq: 41 });
  let fx = newEffects();
  applyBuffering(r, 'b', true, 2_000, fx);
  assert.deepEqual([r.state.paused, r.state.position, r.state.seq, r.state.byUserId], [true, 12, 42, null]);
  assert.deepEqual(fx.buffers, [{ waiting: true, userIds: ['b'] }]);
  assert.equal(fx.waitToken, 2_000);

  fx = newEffects();
  applyBuffering(r, 'c', true, 2_100, fx); // second staller: broadcast only
  assert.equal(r.state.seq, 42);
  assert.deepEqual(fx.buffers, [{ waiting: true, userIds: ['b', 'c'] }]);

  fx = newEffects();
  applyBuffering(r, 'b', false, 2_500, fx);
  releaseBuffering(r, 'c', 3_000, fx); // c leaves the room
  assert.deepEqual([r.state.paused, r.state.updatedAt, r.state.seq], [false, 3_300, 43]);
  assert.deepEqual(fx.buffers.at(-1), { waiting: false, userIds: [] });

  // 8 s timeout drops the straggler; it can't re-trigger a wait until it reports buffering:false.
  fx = newEffects();
  applyBuffering(r, 'b', true, 12_000, fx); // b's last wait start was at 2_000: cooldown over
  onWaitTimeout(r, 11_999, 20_000, fx); // stale token: no-op
  assert.equal(r.buffer.active, true);
  onWaitTimeout(r, 12_000, 20_000, fx);
  assert.deepEqual([r.buffer.active, r.buffer.ignored, r.state.paused], [false, ['b'], false]);
  fx = newEffects();
  applyBuffering(r, 'b', true, 21_000, fx);
  assert.equal(fx.state, false);

  // Play while someone is buffering => Waiting; pause cancels the auto-resume.
  const p = room('ABCDEF');
  applyBuffering(p, 'x', true, 0, newEffects()); // tracked silently while paused
  fx = newEffects();
  applyIntent(p, { type: 'play', position: 5 }, 'u', 100, fx);
  assert.deepEqual([p.state.paused, p.buffer.active, p.buffer.resumeOnClear], [true, true, true]);
  applyIntent(p, { type: 'pause', position: 6 }, 'u', 200, fx);
  assert.deepEqual([p.buffer.active, p.buffer.resumeOnClear], [false, false]);
  applyBuffering(p, 'x', false, 300, fx);
  assert.equal(p.state.paused, true);

  // A lost timer is resolved by the next event.
  const o = room('ABCDEF', { paused: false });
  applyBuffering(o, 'y', true, 0, newEffects());
  fx = newEffects();
  resolveOverdue(o, 8_000, fx);
  assert.deepEqual([o.buffer.active, o.state.paused, o.state.updatedAt], [false, false, 8_300]);
});

test('wait-for-buffer abuse: one wait start per user per 10 s, dropped straggler stays ignored through its cooldown', () => {
  const r = room('ABCDEF', { paused: false });
  let fx = newEffects();
  applyBuffering(r, 'b', true, 0, fx); // first stall: legit wait
  assert.equal(r.state.paused, true);
  applyBuffering(r, 'b', false, 100, fx);
  assert.equal(r.state.paused, false);

  // Looping true/false every ~400 ms no longer stutter-pauses the room...
  for (let t = 500; t < 10_000; t += 400) {
    fx = newEffects();
    applyBuffering(r, 'b', true, t, fx);
    applyBuffering(r, 'b', false, t + 200, fx);
    assert.deepEqual([fx.state, fx.buffers, r.buffer.active], [false, [], false], `t=${t}`);
  }
  // ...but someone else still gets their wait.
  fx = newEffects();
  applyBuffering(r, 'c', true, 9_900, fx);
  assert.deepEqual([r.buffer.active, r.state.paused], [true, true]);
  applyBuffering(r, 'c', false, 9_950, fx);

  // Held stall past the timeout: dropped, and buffering:false within the cooldown does not un-ignore it.
  applyBuffering(r, 'b', true, 10_000, newEffects());
  onWaitTimeout(r, 10_000, 18_000, newEffects());
  assert.deepEqual(r.buffer.ignored, ['b']);
  applyBuffering(r, 'b', false, 18_100, newEffects());
  fx = newEffects();
  applyBuffering(r, 'b', true, 18_200, fx);
  assert.deepEqual([fx.state, r.buffer.active, r.buffer.ignored], [false, false, ['b']]);
  applyBuffering(r, 'b', false, 18_300, newEffects());

  // Cooldown over and recovered: a real stall triggers a wait again.
  fx = newEffects();
  applyBuffering(r, 'b', true, 28_000, fx);
  assert.deepEqual([r.buffer.active, r.buffer.ignored, fx.buffers], [true, [], [{ waiting: true, userIds: ['b'] }]]);
});
