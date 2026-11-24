import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseEnv } from '../env.js';
import { MemoryStore } from '../store/memory.js';

// Stand-in for Next.js: echoes what it received.
const upstream = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'], connection: 'keep-alive' });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString(),
        xff: req.headers['x-forwarded-for'],
        host: req.headers['x-forwarded-host'],
        proto: req.headers['x-forwarded-proto'],
      }),
    );
  });
});
const store = new MemoryStore(60);
let app: FastifyInstance;
let base = '';

before(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const env = parseEnv({ LOG_LEVEL: 'silent', WEB_UPSTREAM: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` });
  app = await buildApp({ env, store, lifecycle: { shuttingDown: false } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(async () => {
  upstream.closeAllConnections();
  upstream.close();
  await app.close();
  await store.close();
});

test('WEB_UPSTREAM: unmatched requests round-trip to the web app, own routes do not', async () => {
  // Like cloudflared on loopback: the edge appended the real client after a spoofed hop.
  const fwd = { 'x-forwarded-for': '6.6.6.6, 203.0.113.5', 'x-forwarded-host': 'party.trycloudflare.com', 'x-forwarded-proto': 'https' };
  const get = await fetch(`${base}/room/ABCDEF?x=1&y=%20`, { headers: fwd });
  assert.equal(get.status, 201);
  assert.deepEqual(get.headers.getSetCookie(), ['a=1', 'b=2']);
  assert.equal(get.headers.get('content-security-policy'), null); // the API CSP must not leak onto pages
  assert.deepEqual(await get.json(), {
    method: 'GET',
    url: '/room/ABCDEF?x=1&y=%20',
    body: '',
    xff: '203.0.113.5',
    host: 'party.trycloudflare.com',
    proto: 'https',
  });

  const post = await fetch(`${base}/form`, { method: 'POST', body: 'a=b&c=d', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const echoed = (await post.json()) as { method: string; body: string; xff: string; proto: string };
  assert.deepEqual([echoed.method, echoed.body, echoed.xff, echoed.proto], ['POST', 'a=b&c=d', '127.0.0.1', 'http']);

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { ok: boolean }).ok, true);
});

test('WEB_UPSTREAM down => 502 plain text', async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 502);
  assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
  assert.match(await res.text(), /Bad gateway/);
});
