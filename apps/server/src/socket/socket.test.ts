import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { io as connect, type Socket } from 'socket.io-client';
import type { Ack, C2SEventName, ClientToServerEvents, ServerToClientEvents } from '@watchparty/shared-types';
import { buildApp } from '../app.js';
import { parseEnv } from '../env.js';
import { MemoryStore } from '../store/memory.js';
import type { AckData } from './handlers/context.js';
import { attachSocket, type SocketLayer } from './index.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
type S2C = keyof ServerToClientEvents;

const env = parseEnv({ LOG_LEVEL: 'silent', TURN_SECRET: 'test-secret' });
const store = new MemoryStore(60);
const app = await buildApp({ env, store, lifecycle: { shuttingDown: false } });
let layer: SocketLayer;
let url = '';
const clients: Client[] = [];

before(async () => {
  layer = attachSocket(app.server, { store, env, log: app.log });
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const c of clients) c.disconnect();
  await layer.close();
  await app.close();
  await store.close();
});

async function client(): Promise<Client> {
  const c: Client = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  clients.push(c);
  await new Promise<void>((resolve, reject) => {
    c.once('connect', resolve);
    c.once('connect_error', reject);
  });
  return c;
}

/** Typed emit-with-ack (the shared map declares `ack?`, which emitWithAck cannot infer through). */
async function ask<E extends C2SEventName>(c: Client, event: E, payload: unknown): Promise<Ack<AckData<E>>> {
  const timed = c.timeout(2_000);
  const emit = timed.emitWithAck as (ev: string, p: unknown) => Promise<Ack<AckData<E>>>;
  return emit.call(timed, event, payload);
}

function data<T>(res: Ack<T>): T {
  if (!res.ok) throw new Error(`ack failed: ${res.error.code} ${res.error.message}`);
  return res.data;
}

const code = <T>(res: Ack<T>) => (res.ok ? 'ok' : res.error.code);

function next<E extends S2C>(c: Client, event: E, match: (p: Parameters<ServerToClientEvents[E]>[0]) => boolean = () => true) {
  type P = Parameters<ServerToClientEvents[E]>[0];
  return new Promise<P>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 2_000);
    const handler = (p: P) => {
      if (!match(p)) return;
      clearTimeout(timer);
      c.off(event, handler as never);
      resolve(p);
    };
    c.on(event, handler as never);
  });
}

// Runs first: the big test below ends by locking out 127.0.0.1 for joins.
test('a socket that disconnects while room:join is in flight leaves no ghost participant', async () => {
  const h = await client();
  const room = data(await ask(h, 'room:create', { nickname: 'Host' }));
  const { getRoom, addParticipant } = store;
  let added = () => {};
  const reached = new Promise<void>((resolve) => (added = resolve));
  store.getRoom = async (c) => {
    await sleep(100); // a slow store round trip before bind(): the disconnect is handled meanwhile, with no roomCode yet
    return getRoom.call(store, c);
  };
  store.addParticipant = async (...args) => {
    added();
    return addParticipant.apply(store, args);
  };
  try {
    const g = await client();
    g.emit('room:join', { roomCode: room.roomCode, nickname: 'Ghost' });
    await sleep(20); // let the server dispatch the event first (it drops events that arrive after a disconnect)
    g.disconnect();
    await reached;
  } finally {
    store.getRoom = getRoom;
    store.addParticipant = addParticipant;
  }
  await sleep(50); // the rest of the join handler
  const ids = (await store.listParticipants(room.roomCode)).map((p) => p.id);
  assert.deepEqual(ids, [room.userId]);
  h.disconnect();
});

test('overlapping create/join on one socket: the second is rejected, no ghost', async () => {
  const c = await client();
  const [first, second] = await Promise.all([ask(c, 'room:create', { nickname: 'One' }), ask(c, 'room:create', { nickname: 'Two' })]);
  assert.equal(code(first), 'ok');
  assert.equal(code(second), 'RATE_LIMITED');
  const room = data(first);
  assert.deepEqual((await store.listParticipants(room.roomCode)).map((p) => p.id), [room.userId]);
  c.disconnect();
});

test('room lifecycle, playback, buffering, chat, queue, rtc, http, limits', async () => {
  const a = await client();
  const b = await client();

  const pong = data(await ask(a, 'sync:ping', { t0: 123 }));
  assert.equal(pong.t0, 123);
  assert.ok(pong.t2 >= pong.t1);

  const settingsA = next(a, 'room:settings');
  const created = data(await ask(a, 'room:create', { nickname: '  Alice\u0007 ', mediaUrl: 'https://cdn.example.com/m.mp4' }));
  assert.deepEqual(await settingsA, { hostOnlyControl: false });
  assert.equal(created.participants[0]?.nickname, 'Alice');
  assert.deepEqual([created.state.kind, created.state.mode, created.state.seq], ['file', 'A', 1]);

  const partsA = next(a, 'room:participants', (p) => p.participants.length === 2);
  const joined = data(await ask(b, 'room:join', { roomCode: created.roomCode.toLowerCase(), nickname: 'Bob' }));
  assert.equal(joined.hostId, created.userId);
  assert.equal((await partsA).hostId, created.userId);

  // Any participant controls playback by default.
  const stateA = next(a, 'room:state', (p) => p.state.seq === 2);
  assert.equal(data(await ask(b, 'player:play', { position: 10 })).seq, 2);
  const s2 = (await stateA).state;
  assert.deepEqual([s2.paused, s2.position, s2.byUserId], [false, 10, joined.userId]);

  // Wait-for-buffer: pause everyone, then a scheduled resume in the future.
  const bufOn = next(a, 'room:buffer', (p) => p.waiting);
  const paused = next(a, 'room:state', (p) => p.state.paused);
  data(await ask(b, 'player:buffering', { buffering: true }));
  assert.deepEqual((await bufOn).userIds, [joined.userId]);
  assert.equal((await paused).state.byUserId, null);
  const resumed = next(a, 'room:state', (p) => !p.state.paused);
  const t = Date.now();
  data(await ask(b, 'player:buffering', { buffering: false }));
  assert.ok((await resumed).state.updatedAt > t);

  // Chat sanitizing + timestamp tags.
  const msg = next(a, 'chat:message');
  data(await ask(b, 'chat:send', { text: 'look @1:30‮' }));
  const m = await msg;
  assert.deepEqual([m.text, m.timestamps, m.nickname], ['look @1:30', [90], 'Bob']);

  // Reactions use the allowlist.
  assert.equal(code(await ask(b, 'reaction:send', { emoji: '🍿' })), 'ok');
  assert.equal(code(await ask(b, 'reaction:send', { emoji: 'x' })), 'INVALID_PAYLOAD');

  // Queue add + next.
  const qUpdate = next(b, 'queue:update', (p) => p.queue.length === 1);
  const item = data(await ask(a, 'queue:add', { mediaUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).item;
  assert.equal(item.kind, 'youtube');
  assert.equal((await qUpdate).queue[0]?.id, item.id);
  assert.equal(data(await ask(a, 'queue:next', {})).kind, 'youtube');
  assert.equal(code(await ask(a, 'queue:next', {})), 'INVALID_PAYLOAD');

  // RTC relay only within the room.
  const offer = next(a, 'rtc:offer');
  data(await ask(b, 'rtc:offer', { to: created.userId, sdp: 'v=0' }));
  assert.deepEqual(await offer, { from: joined.userId, sdp: 'v=0' });
  assert.equal(code(await ask(b, 'rtc:offer', { to: '00000000-0000-4000-8000-000000000000', sdp: 'v=0' })), 'FORBIDDEN');

  // HTTP: TURN for participants only, SSRF guard, health.
  const turn = await app.inject({ url: `/api/turn?roomCode=${created.roomCode}&userId=${joined.userId}` });
  assert.equal(turn.statusCode, 200);
  assert.match(turn.json<{ iceServers: { username?: string }[] }>().iceServers[1]?.username ?? '', /^\d+:/);
  const stranger = await app.inject({ url: `/api/turn?roomCode=${created.roomCode}&userId=00000000-0000-4000-8000-000000000000` });
  assert.equal(stranger.statusCode, 403);
  assert.equal((await app.inject({ url: '/api/turn' })).statusCode, 400);
  for (const target of ['http://127.0.0.1/x', 'http://169.254.169.254/latest', 'http://[::1]/', 'https://example.com:8080/']) {
    const r = await app.inject({ url: `/api/metadata?url=${encodeURIComponent(target)}` });
    assert.equal(r.statusCode, 422, target);
  }
  assert.equal((await app.inject({ url: '/api/metadata?url=javascript:alert(1)' })).statusCode, 400);
  const local = await app.inject({ url: `/api/metadata?url=${encodeURIComponent('local:My Movie.mkv')}` });
  assert.deepEqual(local.json(), { title: 'My Movie.mkv', description: null, image: null, siteName: null, kind: 'local', mode: 'A' });
  assert.deepEqual((await app.inject({ url: '/healthz' })).json<{ ok: boolean; store: string }>().store, 'memory');

  // hostOnlyControl: a guest without ack gets the `error` event; buffering stays allowed.
  data(await ask(a, 'room:settings', { hostOnlyControl: true }));
  assert.equal(code(await ask(b, 'room:settings', { hostOnlyControl: false })), 'FORBIDDEN');
  const forbidden = next(b, 'error');
  b.emit('player:pause', { position: 1 });
  assert.equal((await forbidden).code, 'FORBIDDEN');
  assert.equal(code(await ask(b, 'player:buffering', { buffering: false })), 'ok');
  assert.equal(code(await ask(a, 'player:seek', { position: 'x' })), 'INVALID_PAYLOAD');

  // Host leaves => oldest remaining participant becomes host.
  const handoff = next(b, 'room:participants', (p) => p.hostId === joined.userId);
  a.disconnect();
  assert.equal((await handoff).participants.length, 1);

  // Rate limit is checked before membership: the 6th chat of a burst is RATE_LIMITED.
  const c = await client();
  const codes: string[] = [];
  for (let i = 0; i < 6; i++) codes.push(code(await ask(c, 'chat:send', { text: 'hi' })));
  assert.deepEqual(codes, ['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'RATE_LIMITED']);

  // Room full at 12 (B + 11 more => the 12th extra is refused).
  const extra = await Promise.all(Array.from({ length: 12 }, () => client()));
  const results: string[] = [];
  for (const e of extra) results.push(code(await ask(e, 'room:join', { roomCode: created.roomCode, nickname: 'x' })));
  assert.deepEqual([results.filter((r) => r === 'ok').length, results.at(-1)], [11, 'ROOM_FULL']);

  // Brute force: 10 failures lock the IP, even for a valid code (last: it locks out 127.0.0.1).
  const g = await client();
  for (let i = 0; i < 10; i++) assert.equal(code(await ask(g, 'room:join', { roomCode: 'ZZZZZZ', nickname: 'g' })), 'ROOM_NOT_FOUND');
  assert.equal(code(await ask(g, 'room:join', { roomCode: created.roomCode, nickname: 'g' })), 'TOO_MANY_ATTEMPTS');
});
