import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlaybackState } from '@watchparty/shared-types';
import { ClockSync, computeClockSample, type SyncTransport } from './clock.js';
import { classifyMediaUrl } from './classify.js';
import {
  SyncController,
  computeCorrection,
  expectedPosition,
  type MediaAdapter,
  type MediaAdapterEvent,
} from './controller.js';
import { formatTimecode, parseTimecode } from './timecode.js';

class FakeTransport implements SyncTransport {
  sent: { event: string; payload: unknown }[] = [];
  emit(event: string, payload: unknown, _ack?: unknown): unknown {
    this.sent.push({ event, payload });
    return this;
  }
  on(): unknown {
    return this;
  }
  off(): unknown {
    return this;
  }
}

class FakeAdapter implements MediaAdapter {
  readonly supportsFineRate = true;
  pos = 0;
  paused = true;
  rate = 1;
  ready = 4;
  private readonly cbs = new Map<MediaAdapterEvent, Set<() => void>>();
  getPosition = (): number => this.pos;
  getDuration = (): number | null => 3600;
  getRate = (): number => this.rate;
  isPaused = (): boolean => this.paused;
  seeking = false;
  isSeeking = (): boolean => this.seeking;
  isEnded = (): boolean => false;
  readyState = (): number => this.ready;
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  seek(s: number): void {
    this.pos = s;
  }
  setRate(r: number): void {
    this.rate = r;
  }
  on(e: MediaAdapterEvent, cb: () => void): () => void {
    const set = this.cbs.get(e) ?? new Set();
    set.add(cb);
    this.cbs.set(e, set);
    return () => set.delete(cb);
  }
  fire(e: MediaAdapterEvent): void {
    for (const cb of this.cbs.get(e) ?? []) cb();
  }
  destroy(): void {
    this.cbs.clear();
  }
}

const state = (over: Partial<PlaybackState>): PlaybackState => ({
  mediaUrl: 'https://example.com/a.mp4',
  mode: 'A',
  kind: 'file',
  paused: true,
  position: 0,
  rate: 1,
  updatedAt: 0,
  seq: 1,
  byUserId: null,
  ...over,
});

test('clock offset math and min-RTT selection', () => {
  assert.deepEqual(computeClockSample(1000, 1290, 1292, 1102), { offset: 240, rtt: 100 });

  const clock = new ClockSync(new FakeTransport(), () => 0);
  assert.equal(clock.ready, false);
  // symmetric 100 ms RTT, server 500 ms ahead => exact
  assert.ok(clock.addSample(0, 550, 550, 100));
  assert.equal(clock.offset, 500);
  assert.equal(clock.rtt, 100);
  // rtts [30, 12, 12, 40] offsets [5, 100, 110, 7] => median of ties
  const c2 = new ClockSync(new FakeTransport(), () => 0);
  for (const [rtt, offset] of [[30, 5], [12, 100], [12, 110], [40, 7]] as const) {
    c2.addSample(0, offset + rtt / 2, offset + rtt / 2, rtt);
  }
  assert.equal(c2.offset, 105);
  assert.equal(c2.rtt, 12);
  assert.equal(c2.serverNow(), 105);
  // rejected samples
  assert.equal(c2.addSample(1000, 0, 10, 1005), false); // rtt < 0
  assert.equal(c2.addSample(0, 0, 0, 6000), false); // rtt > CLOCK_MAX_RTT_MS
  // window keeps 10 newest: the old 12 ms samples get evicted
  for (let i = 0; i < 10; i++) c2.addSample(0, 50, 50, 20);
  assert.equal(c2.rtt, 20);
  assert.equal(c2.offset, 40);
});

test('expected position and drift bands', () => {
  const playing = state({ paused: false, position: 120, rate: 1.25, updatedAt: 1_700_000_000_000 });
  assert.equal(expectedPosition(playing, 1_700_000_004_000), 125);
  assert.equal(expectedPosition({ ...playing, paused: true }, 1_700_000_004_000), 120);
  assert.equal(expectedPosition(playing, 1_699_999_999_700), 120); // scheduled resume: frozen

  const rate = (d: number): number => {
    const c = computeCorrection(d, 1, 0, 0);
    assert.equal(c.type, 'rate');
    return c.type === 'rate' ? Number(c.rate.toFixed(6)) : NaN;
  };
  assert.equal(rate(0.05), 1);
  assert.equal(rate(0.08), 0.997867);
  assert.equal(rate(0.5), 0.986667);
  assert.equal(rate(0.75), 0.98);
  assert.equal(rate(-0.75), 1.02);
  assert.equal(rate(-1), 1.026667);
  assert.equal(rate(1.5), 0.96);
  assert.equal(rate(-1.5), 1.04);
  assert.deepEqual(computeCorrection(1.6, 1.25, 100, 10), { type: 'seek', position: 10 + 0.05 * 1.25 });
  assert.deepEqual(computeCorrection(0.5, 1, 0, 0, false), { type: 'none' });
  assert.equal(computeCorrection(0.6, 1, 0, 0, false).type, 'seek');
});

test('classifyMediaUrl', () => {
  const cases: [string, string | undefined, Record<string, string> | null][] = [
    ['https://cdn.example.com/live/master.m3u8?token=abc', undefined, { kind: 'hls', mode: 'A' }],
    ['https://example.com/stream', 'application/x-mpegURL; charset=utf-8', { kind: 'hls', mode: 'A' }],
    ['https://example.com/movie.MP4', undefined, { kind: 'file', mode: 'A' }],
    ['https://example.com/a.mkv#t=10', undefined, { kind: 'file', mode: 'A' }],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42', undefined, { kind: 'youtube', youtubeId: 'dQw4w9WgXcQ' }],
    ['https://youtu.be/dQw4w9WgXcQ?si=x', undefined, { kind: 'youtube', youtubeId: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', undefined, { kind: 'youtube', youtubeId: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', undefined, { kind: 'youtube', youtubeId: 'dQw4w9WgXcQ' }],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', undefined, { kind: 'youtube', mode: 'A' }],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', undefined, { kind: 'youtube', mode: 'A' }],
    ['https://www.youtube.com/watch?v=short', undefined, { kind: 'unknown', mode: 'C' }],
    ['https://www.youtube.com/@somechannel', undefined, { kind: 'unknown', mode: 'C' }],
    ['blob:http://localhost:3000/4f9c0000-0000-0000-0000-000000000000', undefined, { kind: 'local', mode: 'A' }],
    ['file:///C:/Movies/a.mkv', undefined, { kind: 'local', mode: 'A' }],
    ['local:My Movie (2019).mkv', undefined, { kind: 'local', url: 'local:My Movie (2019).mkv' }],
    ['local:../etc/passwd', undefined, null],
    ['https://www.netflix.com/watch/80100172', undefined, { kind: 'drm', mode: 'B', provider: 'netflix' }],
    ['https://www.amazon.co.uk/gp/video/detail/B0ABC', undefined, { kind: 'drm', provider: 'amazon' }],
    ['https://www.amazon.de/gp/video/detail/x', undefined, { kind: 'drm', provider: 'amazon' }],
    ['https://www.amazon.com/dp/B0ABC', undefined, { kind: 'unknown', mode: 'C' }],
    ['https://play.max.com/video/watch/x', undefined, { kind: 'drm', provider: 'max' }],
    ['https://tv.apple.com/us/show/x', undefined, { kind: 'drm', provider: 'appletv' }],
    ['https://www.apple.com/tv', undefined, { kind: 'unknown' }],
    ['https://moviebox.ph/movies/x', undefined, { kind: 'drm', provider: 'moviebox' }],
    ['https://moviebox.ng/movies/x', undefined, { kind: 'drm', provider: 'moviebox' }],
    ['https://moviebox.top/login', undefined, { kind: 'unknown', mode: 'C' }],
    ['https://www.amazon.evil/gp/video/x', undefined, { kind: 'unknown', mode: 'C' }],
    ['https://www.primevideo.com/detail/x', undefined, { kind: 'drm', provider: 'primevideo' }],
    ['https://www.disneyplus.com/video/x', undefined, { kind: 'drm', provider: 'disneyplus' }],
    ['https://www.hulu.com/watch/x', undefined, { kind: 'drm', provider: 'hulu' }],
    ['https://www.hbomax.com/x', undefined, { kind: 'drm', provider: 'hbomax' }],
    ['https://www.peacocktv.com/watch/x', undefined, { kind: 'drm', provider: 'peacock' }],
    ['https://www.paramountplus.com/shows/x', undefined, { kind: 'drm', provider: 'paramountplus' }],
    ['https://www.crunchyroll.com/watch/x', undefined, { kind: 'drm', provider: 'crunchyroll' }],
    ['https://www.hotstar.com/in/x', undefined, { kind: 'drm', provider: 'hotstar' }],
    ['https://www.jiocinema.com/movies/x', undefined, { kind: 'drm', provider: 'jiocinema' }],
    ['https://notnetflix.com/watch/1', undefined, { kind: 'unknown' }],
    ['https://netflix.com.evil.io/watch/1', undefined, { kind: 'unknown' }],
    ['https://example.com/page', undefined, { kind: 'unknown', mode: 'C' }],
    ['javascript:alert(1)', undefined, null],
    ['ftp://host/a.mp4', undefined, null],
    ['https://user:pw@example.com/a.mp4', undefined, null],
    ['not a url', undefined, null],
    [' ', undefined, null],
  ];
  for (const [input, ct, expected] of cases) {
    const got = classifyMediaUrl(input, ct);
    if (expected === null) {
      assert.equal(got, null, input);
      continue;
    }
    assert.ok(got, input);
    for (const [k, v] of Object.entries(expected)) assert.equal((got as Record<string, unknown>)[k], v, `${input} ${k}`);
  }
});

test('timecode', () => {
  assert.equal(parseTimecode('1:02:03'), 3723);
  assert.equal(parseTimecode('12:34'), 754);
  for (const bad of ['1:60', 'abc', '-1:00', '1:2']) assert.equal(parseTimecode(bad), null, bad);
  assert.equal(formatTimecode(754), '12:34');
  assert.equal(formatTimecode(3723), '1:02:03');
  assert.equal(parseTimecode(formatTimecode(3723)), 3723);
});

test('controller: remote lock, debounce, stale seq, buffering grace', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10_000 });
  const transport = new FakeTransport();
  const clock = new ClockSync(transport, () => Date.now());
  const adapter = new FakeAdapter();
  adapter.paused = false;
  const ctl = new SyncController({ transport, clock, adapter });
  const intents = (): string[] => transport.sent.map((s) => s.event);

  // remote pause applies under the lock; its echo is not an intent
  ctl.applyState(state({ paused: true, position: 30, seq: 5 }));
  assert.equal(adapter.paused, true);
  assert.equal(adapter.pos, 30);
  assert.equal(ctl.isRemoteAction(), true);
  adapter.fire('pause');
  assert.equal(ctl.isRemoteAction(), true); // still waiting for 'seeked'
  t.mock.timers.tick(300);
  assert.equal(ctl.isRemoteAction(), false); // timeout release
  t.mock.timers.tick(500);
  assert.deepEqual(intents(), []);

  // stale seq ignored
  ctl.applyState(state({ paused: true, position: 99, seq: 5 }));
  assert.equal(adapter.pos, 30);

  // user seeked after the lock => one seek intent 250 ms after the last of three
  adapter.pos = 40;
  adapter.fire('seeked');
  t.mock.timers.tick(100);
  adapter.fire('seeked');
  t.mock.timers.tick(100);
  adapter.fire('seeked');
  t.mock.timers.tick(249);
  assert.deepEqual(intents(), []);
  t.mock.timers.tick(1);
  assert.deepEqual(transport.sent, [{ event: 'player:seek', payload: { position: 40 } }]);

  // pause then play within 150 ms => one play; it also cancels a pending seek
  transport.sent = [];
  adapter.fire('seeked');
  adapter.fire('pause');
  t.mock.timers.tick(50);
  adapter.fire('play');
  t.mock.timers.tick(150);
  t.mock.timers.tick(300);
  assert.deepEqual(intents(), ['player:play']);

  // buffering: 300 ms stall => nothing, >400 ms => report, playing => clear
  transport.sent = [];
  adapter.ready = 2;
  adapter.fire('waiting');
  t.mock.timers.tick(300);
  adapter.fire('playing');
  t.mock.timers.tick(200);
  assert.deepEqual(intents(), []);
  adapter.fire('waiting');
  t.mock.timers.tick(500);
  assert.deepEqual(transport.sent, [{ event: 'player:buffering', payload: { buffering: true } }]);
  adapter.ready = 4;
  adapter.fire('playing');
  assert.deepEqual(transport.sent.at(-1), { event: 'player:buffering', payload: { buffering: false } });

  // slow remote seek: lock held while the adapter is still seeking; a late `seeked` is not echoed as an intent
  transport.sent = [];
  ctl.applyState(state({ paused: true, position: 50, seq: 6 }));
  adapter.seeking = true;
  t.mock.timers.tick(600);
  assert.equal(ctl.isRemoteAction(), true);
  adapter.seeking = false;
  t.mock.timers.tick(300);
  assert.equal(ctl.isRemoteAction(), false);
  adapter.fire('seeked');
  t.mock.timers.tick(300);
  assert.deepEqual(intents(), []);
  ctl.destroy();
});
