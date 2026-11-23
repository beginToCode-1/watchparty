# DevOps and Security Specification

Status: v1 spec, written before implementation. This document is normative for storage, scaling, abuse controls, browser security policy and deployment.
Related: [ARCHITECTURE.md](./ARCHITECTURE.md), [SYNC_PROTOCOL.md](./SYNC_PROTOCOL.md) (event semantics, buffering state machine), [EXTENSION_SPEC.md](./EXTENSION_SPEC.md) (extension trust model), [WEBRTC_AND_MEDIA.md](./WEBRTC_AND_MEDIA.md) (TURN credentials, Coturn config, SSRF-safe fetcher), [IMPLEMENTATION_ROADMAP.md](./IMPLEMENTATION_ROADMAP.md), [../README.md](../README.md), [../CLAUDE.md](../CLAUDE.md).

---

## 1. Deployment topology

```mermaid
flowchart LR
    subgraph Clients
      B1[Browser: web app]
      B2[Browser: extension content script]
    end
    subgraph Edge["Host: public IP"]
      NG["nginx :80 / :443<br/>TLS termination, WS upgrade, sticky hash"]
      CT["coturn :3478 udp+tcp, :5349 tls<br/>relay 49160-49200/udp"]
    end
    subgraph Backend["docker network 'backend' (not published)"]
      W["web (Next.js) :3000"]
      S1["server #1 :4000"]
      S2["server #2 :4000"]
      R[("redis:7-alpine :6379<br/>keys + pub/sub")]
    end
    B1 -- "https watch.example.com" --> NG
    B1 -- "wss/https api.watch.example.com" --> NG
    B2 -- "wss api.watch.example.com" --> NG
    NG --> W
    NG -- "hash $binary_remote_addr consistent" --> S1
    NG --> S2
    S1 <--> R
    S2 <--> R
    B1 <-. "STUN/TURN (UDP/TCP/TLS)" .-> CT
```

| Component | Image or build | Public ports | Scales |
|---|---|---|---|
| nginx | `nginx:1.27-alpine` or the host package | 80/tcp, 443/tcp | 1 per host |
| web | `apps/web/Dockerfile` (Next.js `output: 'standalone'`) | none in production (behind nginx) | horizontally, stateless |
| server | `apps/server/Dockerfile` | none in production (behind nginx) | horizontally, with `REDIS_URL` set (section 3) |
| redis | `redis:7-alpine` | **none** (bound to `127.0.0.1` in dev) | 1 primary (optionally a replica plus Sentinel, out of scope for v1) |
| coturn | `coturn/coturn:4.6.3` | 3478 udp+tcp, 5349 tcp+udp, 49160-49200/udp | 1 per public IP |

**Local dev without Docker** (the team's Windows machines): leave `REDIS_URL` unset, and the server uses `store/memory.ts` (single instance, no TTL persistence). Leave `TURN_SECRET` unset, and `/api/turn` returns STUN only, which is enough for localhost and LAN peers.

---

## 2. Redis keyspace

### 2.1 Keys

`{code}` is the 6-character room code. Every key that belongs to a room shares one TTL, `ROOM_TTL_SECONDS` (default 86400), refreshed on activity (section 2.3).

| Key | Type | Contents | TTL | Max size | Written by |
|---|---|---|---|---|---|
| `room:{code}` | hash | `meta`: JSON `{ code, createdAt, hostId, hostOnlyControl }`. `state`: JSON `PlaybackState` `{ mediaUrl, mode, kind, paused, position, rate, updatedAt, seq, byUserId }`. `buffer`: JSON `{ active, userIds[], ignored[], startedAt, resumeOnClear }` (wait-for-buffer record, [SYNC_PROTOCOL.md section 8](./SYNC_PROTOCOL.md#8-wait-for-buffer)) | `ROOM_TTL_SECONDS`, refreshed | about 1.5 KiB | `room:create`, `room:settings`, host change, every state or buffer mutation |
| `room:{code}:participants` | hash | field `userId` -> JSON `{ id, nickname, isHost, joinedAt, media:{audio,video,screen}, socketId }` | same | 12 fields x about 250 B | join, leave, disconnect, `rtc:media`, host change |
| `room:{code}:chat` | list | JSON `chat:message` `{ id, userId, nickname, text, timestamps, at }`, oldest first | same | **200** entries (`LTRIM -200 -1`), up to about 700 B each | `chat:send` |
| `room:{code}:queue` | list | JSON `{ id, mediaUrl, title, addedBy, kind, mode }` | same | **50** entries (`QUEUE_MAX` in shared-types) | `queue:add`, `queue:remove`, `queue:next` |
| `ratelimit:join:{ip}` | string (counter) | failed `room:join` attempts (each join INCRs first; refunded with DECR when the code names a real room) | **600 s**, set on the first hit and not extended | 1 integer | `room:join` |
| `ratelimit:create:{ip}` | string (counter) | `room:create` calls, max `CREATE_MAX` (20) | **600 s**, set on the first hit and not extended | 1 integer | `room:create` |

The contract's server-side "set of buffering socket ids" is stored as the `buffer` field of `room:{code}`, keyed by `userId` (sockets and users map 1:1). It therefore changes in the same `WATCH` transaction as `state`, and buffer and state can never disagree across instances. Without Redis, `memory.ts` keeps the same record in a `Map`.

Not stored in Redis, and why:

| Data | Lives in | Reason |
|---|---|---|
| Token buckets (section 4) | `socket.data` on the instance holding the socket | A socket never moves between instances, so the buckets die with it. |
| Socket to room and user mapping | `socket.data.{roomCode,userId}` plus Socket.IO rooms `room:{code}` and `user:{userId}` | The adapter already distributes room membership. |
| Metadata cache, content-type probe cache | in-process LRU (`Map`, 500 entries, 10 min) | Cheap to recompute, and per-instance caching is fine. |
| Socket.IO adapter traffic | Redis **pub/sub channels** `socket.io#/#...`, `socket.io-request#/#`, `socket.io-response#/#` | Channels, not keys, so they take no memory and are not evicted. |

### 2.2 Command patterns

| Operation | Commands (pipelined or transactional) |
|---|---|
| Create room | Generate the code (section 4.3). `HSETNX room:{c} meta <json>`; if 0, retry with a new code (max 5). Then `MULTI; HSET room:{c} state <json>; HSET room:{c}:participants <uid> <json>; EXPIRE` x all room keys; `EXEC` |
| Join | Validate (section 4.3) -> `EXISTS room:{c}` -> `HLEN room:{c}:participants` (>= 12 gives `ROOM_FULL`) -> `MULTI; HSET participants; EXPIRE x4; EXEC` -> `LRANGE room:{c}:chat -50 -1` and `LRANGE room:{c}:queue 0 -1`. Join is the one path where the room-full check races. Two simultaneous joins at 11 participants can produce 13. The check runs again after `HSET` (`HLEN > 12` gives `HDEL` plus `ROOM_FULL`). |
| State mutation (play, pause, seek, rate, load, buffering transitions) | Optimistic concurrency: `WATCH room:{c}` -> `HGETALL room:{c}` -> compute the new `state` (`seq = old.seq + 1`, `updatedAt = serverNow`) and `buffer` -> `MULTI; HSET room:{c} state <json> buffer <json>; EXPIRE x4; EXEC`. A null EXEC (another instance wrote first) retries up to 5 times. This gives the contract's strictly monotonic `seq` across instances without Lua. |
| Chat | `RPUSH room:{c}:chat <json>; LTRIM room:{c}:chat -200 -1` |
| Queue remove | `LRANGE room:{c}:queue 0 -1` -> find the item by `id` -> `LREM room:{c}:queue 1 <exact json>` |
| Queue next | `LPOP room:{c}:queue`, then a state mutation with `player:load` semantics |
| Leave or disconnect | `HDEL participants <uid>`, then a state mutation that removes `uid` from `buffer.userIds` and `buffer.ignored` (which may resume the room). If `uid === hostId`, `HGETALL participants`, choose the minimum `joinedAt` (ties broken by `userId`), and update `meta.hostId` inside a `WATCH room:{c}` transaction. If the hash is empty, nothing is deleted, but every room key gets `EXPIRE 300` (`EMPTY_ROOM_TTL_S`): a reload within 5 minutes rejoins it, and abandoned rooms do not pile up for 24 h. |
| Join attempt | `INCR ratelimit:join:{ip}` then `EXPIRE ratelimit:join:{ip} 600 NX` (Redis 7 `NX`: set the TTL only on the first hit), gated on the INCR result; a Lua `EXISTS`+`DECR` refunds it when the room exists |

### 2.3 TTL refresh ("activity")

Any **mutating** event (join, leave, state mutation, chat, reaction, queue, settings, `rtc:media`) refreshes the TTL with `EXPIRE <key> ROOM_TTL_SECONDS` on all four room keys. The `EXPIRE`s are queued in the same `MULTI` or pipeline as the write, so they cost no extra round trip. `sync:ping` and `rtc:offer/answer/ice` do **not** refresh the TTL, because they are not room activity.

**Invariant:** every key this app writes has a TTL. CI's integration test runs `SCAN 0 MATCH * COUNT 1000` plus `TTL` against a test Redis and fails if any app key returns `-1`.

### 2.4 Eviction, persistence and memory sizing

| Setting | Value | Why |
|---|---|---|
| `maxmemory` | `256mb` (start), with an alert at 80 % of `used_memory` | See the sizing below. |
| `maxmemory-policy` | **`volatile-ttl`** | Every key has a TTL, and all of a room's keys share one TTL, refreshed together. `volatile-ttl` evicts the keys **closest to expiry**, which are those of the most idle rooms, so whole idle rooms go first. `allkeys-lru` could evict a live room's participants hash on its own, and `noeviction` turns memory pressure into failed joins. |
| `appendonly` | `yes`, `appendfsync everysec` | Rooms survive a Redis restart, with at most 1 s of chat or state lost. |
| `save` | `""` (RDB snapshots off, AOF only) | One persistence mechanism. |
| `protected-mode` | `yes` (default), plus `requirepass` or ACL | |
| `timeout` | `0` | ioredis keeps long-lived connections, with its own keepalive. |

Sizing for a worst-case room (12 participants, 200 chat messages of about 700 B, 50 queue items) is about 1 + 3 + 140 + 15 = **160 KiB**. A typical room (light chat) is **10 to 20 KiB**. 256 MiB therefore holds about 1,600 worst-case rooms, or 10,000 or more typical rooms. Scale `maxmemory` with expected concurrency.

### 2.5 Redis access control

The baseline is `requirepass`, which the compose file in section 7.2 sets, with `REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379`. For hardening, replace it with a dedicated ACL user, provided by a mounted `users.acl` or `redis.conf`:

```
user default off
user watchparty on >${REDIS_PASSWORD} ~room:* ~ratelimit:* &socket.io* +@all -@dangerous +info
```

- `-@dangerous` blocks `KEYS`, `FLUSHALL`, `CONFIG`, `DEBUG` and similar commands. `+info` is re-allowed because ioredis's ready check sends `INFO`.
- `&socket.io*` limits pub/sub to the adapter's channels.
- With the ACL user, set `REDIS_URL=redis://watchparty:${REDIS_PASSWORD}@redis:6379`. The password is hex (`openssl rand -hex 32`), so the URL needs no escaping.
- Redis is never published on a public interface. Use TLS (`rediss://`) only if Redis runs on another host.

---

## 3. Horizontal scaling with `@socket.io/redis-adapter`

### 3.1 Wiring

```ts
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';

const pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, enableAutoPipelining: true });
const sub = pub.duplicate();                       // pub/sub needs its own connection
io.adapter(createAdapter(pub, sub, { key: 'socket.io', requestsTimeout: 5_000 }));
// the store (store/redis.ts) uses its own third connection, so a slow SUBSCRIBE never blocks HSETs
```

Socket.IO server options:

| Option | Value | Why |
|---|---|---|
| `transports` | `['websocket', 'polling']` | The web app keeps the polling fallback for proxies that block WS. The extension connects with websocket only. |
| `pingInterval` / `pingTimeout` | 25 000 / 20 000 ms | Defaults. nginx's `proxy_read_timeout` (75 s) must be larger than their sum. |
| `maxHttpBufferSize` | 65 536 B | The largest legitimate payload is `rtc:offer` (SDP max 32 KiB, [WEBRTC_AND_MEDIA.md section 4.3](./WEBRTC_AND_MEDIA.md#43-signaling-payloads-zod-watchpartyshared-typesschemasts)). The default of 1 MB is an easy memory DoS. |
| `connectTimeout` | 10 000 ms | |
| `cors` / `allowRequest` | see section 6.1 | |
| `connectionStateRecovery` | **not used** | It is not supported by the classic Redis adapter. Rejoin is handled at the app level ([SYNC_PROTOCOL.md](./SYNC_PROTOCOL.md)). |

### 3.2 Routing rules

| Need | Mechanism |
|---|---|
| Broadcast to a room (`room:state`, `chat:message`, and so on) | `io.to('room:' + code).emit(...)`. The adapter publishes to every instance. |
| Send to one user (`rtc:*` relay) | Each socket `join('user:' + userId)` on join. Then `io.to('user:' + to).emit(...)`, after checking `HEXISTS room:{c}:participants {to}`. |
| Room state, participants, chat, queue | Always read and written through `store/redis.ts`. No instance caches room state. |
| Stale participants after an instance crash | **Reconcile** on every `room:join` and host election: `io.in('room:' + code).fetchSockets()` (cluster-wide through the adapter), then `HDEL` participants whose `socketId` is not live, and elect a new host if needed. If `fetchSockets` times out (5 s), reconciling is skipped for that call and the join still succeeds. |

### 3.3 Sticky sessions

The polling transport sends several HTTP requests per session, and they must reach the **same** instance. nginx uses `hash $binary_remote_addr consistent` (section 7.3). WebSocket-only clients, such as the extension, would not need stickiness, but the hash does no harm. When replicas are added or removed, nginx must be reloaded, because it resolves `server:4000` to the replica IPs at startup. Consistent hashing moves only about 1/N of the clients.

### 3.4 Timers across instances (buffer wait and scheduled resume)

The semantics are in [SYNC_PROTOCOL.md](./SYNC_PROTOCOL.md). This section defines only how they survive many instances:

- Every buffering transition (`player:buffering`, leave, disconnect, the 8 s timeout) is a state mutation (section 2.2) that rewrites `state` and `buffer` together, so any instance can handle any event.
- The 8 s timer is an in-process `setTimeout` on the instance that moved the room into waiting. Its callback re-reads the room and acts only if `buffer.active` is still true and `buffer.startedAt` is unchanged, so it is idempotent.
- If that instance dies, the timer is lost. The recovery is `resolveOverdue()` from SYNC_PROTOCOL.md: any later `player:*` event on any instance checks `buffer.active && now - buffer.startedAt >= 8000` and resolves the wait.
- **Safety net (addition):** every 2 s, each instance also calls `resolveOverdue()` for the rooms it has local sockets in, which are the keys of `io.of('/').adapter.rooms` that start with `room:`. It uses one pipelined `HGET room:{c} buffer` per room. This covers the case where everybody is waiting and nobody sends a `player:*` event. Worst-case wait: 10 s.
- Concurrent resolution from two instances is harmless. The `WATCH` transaction makes the second one see `buffer.active === false` and skip.

### 3.5 Graceful shutdown

On `SIGTERM`:
1. `/healthz` starts returning `503`, so the orchestrator or nginx stops sending new traffic.
2. `io.close()` disconnects local sockets. Clients reconnect, usually to another instance, and rejoin.
3. `app.close()` drains Fastify. `pub`, `sub` and the store connections `quit()`.
4. The process exits within the 30 s `stop_grace_period`.

---

## 4. Per-socket token-bucket rate limits

### 4.1 Algorithm (`lib/rateLimit.ts`)

```ts
type Bucket = { tokens: number; last: number };
// capacity = burst, ratePerMs = refill tokens per millisecond
export function take(b: Bucket, capacity: number, ratePerMs: number, now = Date.now()): boolean {
  b.tokens = Math.min(capacity, b.tokens + (now - b.last) * ratePerMs);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
```

Buckets live in `socket.data.buckets` and start full. They are checked **before** Zod parsing, so malformed floods also use up tokens. The same `take()` backs the per-IP HTTP limits, using an in-process `Map<ip, Bucket>` with entries pruned after 10 minutes idle.

### 4.2 Limits

| Event(s) | Bucket | Capacity (burst) | Refill | Source |
|---|---|---|---|---|
| `chat:send` | `chat` | 5 | 1 token/s (5 per 5 s) | contract |
| `reaction:send` | `reaction` | 10 | 5 tokens/s (10 per 2 s) | contract |
| `player:play`, `player:pause`, `player:seek`, `player:rate`, `player:buffering`, `player:load`, plus `room:*` and `queue:*` | `player` (shared) | 20 | 4 tokens/s (20 per 5 s) | contract (`player:*`). `room:*` and `queue:*` had no bucket in the contract; they share this one, per [ARCHITECTURE.md section 8.2](./ARCHITECTURE.md#82-rate-limits). |
| `sync:ping` | `sync` | 20 | 4 tokens/s | contract. The connect burst of 8 fits. |
| `rtc:offer`, `rtc:answer`, `rtc:ice`, `rtc:media` | `rtc` | 200 | 20 tokens/s (200 per 10 s) | contract (`rtc:*`) |
| `room:join` **failures** | Redis `ratelimit:join:{ip}` | 10 per IP, fixed 10-minute window | n/a | contract (section 4.3) |
| HTTP `GET /api/metadata` | per IP | 30 | 0.5 tokens/s (30 per 60 s) | implemented (`RATE_LIMITS.metadata`, `apps/server/src/app.ts`) |
| HTTP `GET /api/turn` | per IP | 10 | 1 token per 6 s | implemented (`RATE_LIMITS.turn`, `apps/server/src/app.ts`) |
| TCP connections to `/socket.io/` | nginx `limit_conn perip 20` | 20 concurrent per IP | n/a | implemented in `nginx/nginx.conf` |

When a limit is exceeded:
- The event is **dropped**, with no state change.
- If the client passed an ack, it gets `{ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } }`. Otherwise the server emits `error { code: 'RATE_LIMITED', message }`, at most once per second per socket, so the error replies cannot themselves become a flood.
- More than 100 drops within 60 s calls `socket.disconnect(true)` and logs a `warn` with the room code and IP (implemented in `apps/server/src/socket/index.ts`).
- HTTP limits return `429` with `Retry-After` (seconds until 1 token is available).

### 4.3 Room-code brute-force protection

**Keyspace:** 32^6 = 1,073,741,824 codes from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.

**Generation:**

```ts
import { randomInt } from 'node:crypto';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const generateRoomCode = () => Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
```

Collisions are handled with `HSETNX room:{code} meta` and up to 5 retries (section 2.2). The memory store does the same with `Map.has`.

**Join check order** (`socket/handlers/room.ts`):
1. `INCR ratelimit:join:{ipKey}` (reserves the attempt atomically, so concurrent joins cannot all pass a stale read). If the result is above 10, ack `TOO_MANY_ATTEMPTS` **without looking up the room**, so a locked-out IP learns nothing. Once the code names an existing room the hit is refunded (`DECR`), so only bad codes count.
2. Zod-validate `{roomCode, nickname}`. A malformed code (wrong length or alphabet) counts as a failure and acks `INVALID_PAYLOAD`. Lowercase input is uppercased first.
3. If the room does not exist, count a failure and ack `ROOM_NOT_FOUND`.
4. If the room is full, ack `ROOM_FULL`. This does **not** count as a failure, because the client already knew a valid code.
5. A successful join does **not** reset the counter. Otherwise an attacker could interleave guesses with joins to a room they own.

**`ipKey`:** for IPv4 it is the full address. For IPv6 it is the **/64 prefix** (for example `2001:db8:1:2::/64`), because one host usually controls a whole /64. The client IP is derived as described in section 6.4.

**Risk math** (one IP, 10 guesses per 10 min, so 1,440 per day):

| Active rooms N | P(hit) per guess = N / 32^6 | Expected hits per IP per day | 1,000-IP botnet per day |
|---|---|---|---|
| 1,000 | 9.3e-7 | 0.0013 | 1.3 |
| 10,000 | 9.3e-6 | 0.013 | 13 |
| 100,000 | 9.3e-5 | 0.13 | 134 |

A room code is a **capability to join a 12-seat room**, not a secret protecting data. A successful guess gets read access to that room's chat and a seat, and the host can turn on `hostOnlyControl`. The UI says this when sharing ("Anyone with the code can join").

`ponytail:` the ceiling is distributed guessing at very high room counts. The upgrade path is a global alarm (sum of `INCR` failures per minute, alerting above 500 per minute), then a proof-of-work or CAPTCHA on `room:join` after the first failure.

---

## 5. Input sanitization and XSS

### 5.1 Server-side sanitization (`lib/sanitize.ts`)

The contract rule is: strip control characters and trim on the server. HTML-escaping is the renderer's job. The normative definition is [ARCHITECTURE.md section 8.1](./ARCHITECTURE.md#81-validation-and-sanitisation). This is the same function:

```ts
const STRIP = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g; // C0 + DEL + C1 control chars, bidi embeddings/overrides/isolates
export function sanitizeText(input: string): string {
  return input.replace(/[\r\n\t]+/g, ' ').replace(STRIP, '').trim();
}
```

- CR, LF and TAB become a space first, so words do not run together. Then the remaining control and bidi characters are removed.
- Bidi overrides are stripped to prevent "Trojan Source"-style spoofing in nicknames, for example a name containing U+202E followed by `gnp.exe`, which displays as `exe.png`.
- U+200D (ZWJ) is kept, because it joins emoji sequences. Residual risk: zero-width spaces (U+200B) still allow look-alike nicknames, for example "Host" with a U+200B inside it. The host badge comes from `isHost`, never from the nickname, so impersonating the host does not grant control.

| Field | Raw Zod bound (before sanitizing, caps CPU) | After `sanitizeText` | Failure |
|---|---|---|---|
| `nickname` | `string().max(64)` | length 1..24 (UTF-16 code units, the same unit Zod uses) | `INVALID_PAYLOAD` |
| `chat:send.text` | `string().max(2000)` | length 1..500 | `INVALID_PAYLOAD` |
| `queue:add.title` | `string().max(400).optional()` | length 0..200. If empty, the server uses the metadata title or the last path segment. | n/a |
| metadata `title` / `description` / `siteName` | n/a (server-fetched) | truncated to 200 / 500 / 100 | n/a |
| `reaction:send.emoji` | `z.enum(REACTION_EMOJIS)` (12 allowlisted emoji in shared-types) | n/a | `INVALID_PAYLOAD` |
| `mediaUrl` | `string().max(2048)` -> `classifyMediaUrl` must be non-null | n/a | `INVALID_PAYLOAD` |

Chat timestamps are parsed on the server **after** sanitizing (`lib/timestamps.ts`). The regex is `/(?:^|\s)@(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)(?=\s|$|[.,!?])/g`, the result is a sorted, de-duplicated `number[]` of seconds, and at most 10 per message.

### 5.2 Rendering rules (web app and extension)

| Rule | Enforcement |
|---|---|
| User-controlled strings (nickname, chat text, titles, descriptions, site names) are rendered **only as React text nodes**. | ESLint `react/no-danger: "error"` in the shared config. CI fails on `dangerouslySetInnerHTML`, `innerHTML =`, `outerHTML`, `insertAdjacentHTML` or `document.write` (`git grep` gate). |
| Chat `@mm:ss` tags are rendered as `<button>` elements from the server's `timestamps[]`. The text is split with the same regex, and both pieces stay text nodes. | Code review. |
| No automatic linking of chat text in v1. | Removes a whole class of `javascript:` link bugs. |
| URLs placed in `href` or `src` (`mediaUrl`, `og:image`) are checked again on the client with `new URL()` and protocol `http:`/`https:` (or `blob:` for local playback). | `lib/` helper `safeHttpUrl()`. |
| External links use `target="_blank" rel="noopener noreferrer nofollow"`. | |
| Images from metadata use `referrerPolicy="no-referrer"`. | |
| YouTube is embedded by `youtubeId` only, never by the user's URL string. | |
| The extension sidebar follows the same rules inside a closed shadow root ([EXTENSION_SPEC.md section 9](./EXTENSION_SPEC.md#9-security-checklist-extension)). | |

The CSP in section 6.2 limits the damage if a rule is ever broken.

---

## 6. CORS, CSP and security headers

### 6.1 Server CORS and Socket.IO origin policy

```ts
const allowedOrigins = [
  ...env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  ...env.EXTENSION_IDS.split(',').map((s) => s.trim()).filter(Boolean).map((id) => `chrome-extension://${id}`),
];
```

| Surface | Policy |
|---|---|
| HTTP (`@fastify/cors`) | `origin: allowedOrigins` (exact match), `methods: ['GET']`, `credentials: false`, `maxAge: 600`. `/healthz` is the same but is only used by probes. |
| Socket.IO `cors` (applies to the **polling** transport) | `{ origin: allowedOrigins, credentials: false }` |
| Socket.IO `allowRequest(req, cb)` (runs on every handshake, polling or WebSocket upgrade) | If `req._query.transport === 'polling'`, require `Origin` to be in `allowedOrigins`. If the transport is `websocket`, **accept any Origin**. |

Why WebSocket accepts any Origin: the extension's content script runs inside provider pages, and Chrome sends **the page's origin** (for example `https://www.netflix.com`) on its requests ([EXTENSION_SPEC.md section 8.2](./EXTENSION_SPEC.md#82-socket-configuration)). The Origin check exists to stop cross-site WebSocket hijacking, which abuses **ambient credentials**. This server has none: no cookies, no HTTP auth, no session tied to the browser. Every capability comes from the room code and the per-socket `userId` returned in an ack, so a hostile page can do nothing it could not also do from `curl`. The rate limits in section 4 apply regardless of Origin.

### 6.2 Web app CSP (Next.js 15 middleware, per-request nonce)

`apps/web/src/middleware.ts` generates `nonce = btoa(crypto.randomUUID())`, sets the `Content-Security-Policy` header and passes `x-nonce` so that the App Router applies it to its inline scripts. Pages that use the nonce render dynamically.

```
default-src 'self';
script-src 'self' 'nonce-{NONCE}' 'strict-dynamic';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:;
media-src 'self' blob: https:;
connect-src 'self' {SERVER_ORIGIN} {SERVER_WS_ORIGIN} https:;
frame-src https://www.youtube.com https://www.youtube-nocookie.com;
worker-src 'self' blob:;
font-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

| Directive | Reasoning |
|---|---|
| `script-src 'nonce-...' 'strict-dynamic'` | Next's inline bootstrap scripts carry the nonce. The YouTube `iframe_api` loader is inserted by our nonce'd code and is trusted through `strict-dynamic`. No host allowlists are needed. |
| `style-src 'unsafe-inline'` | Next and React inline style attributes. Style injection is a low-impact risk compared with script injection. |
| `img-src https:` | `og:image` thumbnails can come from any host. |
| `media-src blob: https:` | hls.js plays through MSE `blob:` URLs, and direct files come from any HTTPS host. Plain `http:` media is deliberately excluded (mixed content). |
| `connect-src https:` + server origins | hls.js fetches playlists and segments from arbitrary HTTPS hosts. `{SERVER_ORIGIN}` = `NEXT_PUBLIC_SERVER_URL` origin, and `{SERVER_WS_ORIGIN}` = the same origin with `wss:` (`ws:` in dev). |
| `worker-src blob:` | hls.js worker. |
| `frame-ancestors 'none'` | No clickjacking of room controls. |

In dev (`next dev`), `script-src` also gets `'unsafe-eval'` (React Refresh). `upgrade-insecure-requests` is dropped so that `http://localhost:4000` works.

### 6.3 Other headers

| Header | Web app (`next.config` `headers()`) | Server (Fastify `onSend` hook) |
|---|---|---|
| `Strict-Transport-Security` | set by nginx: `max-age=63072000; includeSubDomains; preload` | set by nginx |
| `X-Content-Type-Options` | `nosniff` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin`, so room URLs `/room/ABC234` never leak their path to third parties | `no-referrer` |
| `Permissions-Policy` | `camera=(self), microphone=(self), display-capture=(self), autoplay=(self "https://www.youtube.com"), fullscreen=(self "https://www.youtube.com"), encrypted-media=(self "https://www.youtube.com"), geolocation=(), payment=(), usb=()` | n/a |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` (YouTube "watch on YouTube" popups keep working) | n/a |
| `Content-Security-Policy` | section 6.2 | `default-src 'none'; frame-ancestors 'none'` (JSON only) |
| `Cache-Control` | Next defaults | `/api/turn`: `no-store`. `/api/metadata`: `public, max-age=600`. |

`Cross-Origin-Embedder-Policy` is **not** set, because it would block cross-origin media and images that do not send CORP headers.

### 6.4 Client IP and trusted proxies

The rule is the one in [ARCHITECTURE.md section 8.2](./ARCHITECTURE.md#82-rate-limits). The client IP is the TCP peer address (`socket.handshake.address`, Fastify `request.socket.remoteAddress`), **except** when that peer is listed in `TRUSTED_PROXIES` (comma-separated IPs/CIDRs; default `127.0.0.1/8,::1/128`, loopback only). In that case the left-most `X-Forwarded-For` entry is used. The same list drives Fastify's `trustProxy` (one `isTrusted` check in `lib/rateLimit.ts`), so HTTP and socket rate limits agree. Private ranges are **not** trusted by default: a LAN or Docker Desktop client reaching the server directly would otherwise forge `X-Forwarded-For` per connection and dodge the join lockout and the per-IP `/api/*` limits. Compose pins the `backend` network to `172.30.0.0/24` and sets `TRUSTED_PROXIES=127.0.0.1/8,::1/128,172.30.0.0/24` so nginx running as a compose service is trusted; the dev-only published server port is bound to `127.0.0.1`. This is safe because nginx **overwrites** `X-Forwarded-For` with `$remote_addr` (section 7.3), so the header holds exactly one value that the client cannot forge. Server ports are never published in production, so no client can reach the server from a trusted address while bypassing nginx.

### 6.5 Extension CSP

MV3 defaults are kept: `extension_pages: "script-src 'self'; object-src 'self'"`. Remote code is never loaded. The content script runs in Chrome's isolated world, so page CSPs do not block its socket connection.

---

## 7. Production deployment

### 7.1 Environment (`.env` next to `docker-compose.yml`, never committed)

| Variable | Used by | Example | Notes |
|---|---|---|---|
| `PORT`, `HOST` | server | `4000`, `0.0.0.0` | contract |
| `CORS_ORIGINS` | server | `https://watch.example.com` | contract |
| `EXTENSION_IDS` | server | `abcdefghijklmnopabcdefghijklmnop` | contract |
| `REDIS_URL` | server | `redis://:${REDIS_PASSWORD}@redis:6379` | contract. Unset means the memory store (single instance only). |
| `REDIS_PASSWORD` | redis, server | `openssl rand -hex 32` | compose-level |
| `TURN_SECRET` | server, coturn | `openssl rand -hex 32` | contract. **Hex only** (it goes through the `sed` render). |
| `TURN_URLS` | server | `turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp` | contract |
| `STUN_URLS` | server | `stun:turn.example.com:3478,stun:stun.l.google.com:19302` | contract |
| `TURN_EXTERNAL_IP` | coturn | `203.0.113.10` (or `203.0.113.10/172.18.0.5` when behind Docker NAT) | compose-level |
| `ROOM_TTL_SECONDS`, `LOG_LEVEL` | server | `86400`, `info` | contract |
| `TRUSTED_PROXIES` | server | `127.0.0.1/8,::1/128,172.30.0.0/24` | IPs/CIDRs whose `X-Forwarded-For` is believed (section 6.4). Server default: loopback only. |
| `NEXT_PUBLIC_SERVER_URL`, `NEXT_PUBLIC_EXTENSION_ID` | web (**build args**) | `https://api.watch.example.com` | Inlined at `next build`. Changing them needs a rebuild. |

### 7.2 `docker-compose.yml` (production)

```yaml
name: watchparty

services:
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes", "--appendfsync", "everysec", "--save", "",
              "--maxmemory", "256mb", "--maxmemory-policy", "volatile-ttl",
              "--requirepass", "${REDIS_PASSWORD:?REDIS_PASSWORD is required}"]
    environment:
      REDISCLI_AUTH: ${REDIS_PASSWORD}
    ports: ["127.0.0.1:6379:6379"]            # loopback only; remove entirely if no host-side debugging
    volumes: ["redis-data:/data"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped
    networks: [backend]

  coturn:
    image: coturn/coturn:4.6.3
    environment:
      TURN_SECRET: ${TURN_SECRET:?TURN_SECRET is required}
      TURN_EXTERNAL_IP: ${TURN_EXTERNAL_IP:?TURN_EXTERNAL_IP is required}
    entrypoint: ["/bin/sh", "-c"]
    command:
      - >-
        sed -e "s|\$${TURN_SECRET}|$${TURN_SECRET}|g"
        -e "s|\$${TURN_EXTERNAL_IP}|$${TURN_EXTERNAL_IP}|g"
        /etc/coturn/turnserver.conf.template > /tmp/turnserver.conf
        && exec turnserver -c /tmp/turnserver.conf
    volumes:
      - ./coturn/turnserver.conf:/etc/coturn/turnserver.conf.template:ro
      - ./certs/turn:/etc/coturn/certs:ro      # fullchain.pem + privkey.pem readable by uid 'nobody'
    ports:
      - "3478:3478/udp"
      - "3478:3478/tcp"
      - "5349:5349/tcp"
      - "5349:5349/udp"
      - "49160-49200:49160-49200/udp"
    restart: unless-stopped
    # Production alternative (Linux): network_mode: host, then drop 'ports' and widen min-port/max-port (see WEBRTC_AND_MEDIA.md section 5.3)

  server:
    build: { context: ., dockerfile: apps/server/Dockerfile }
    environment:
      PORT: 4000
      HOST: 0.0.0.0
      CORS_ORIGINS: ${CORS_ORIGINS:-http://localhost:3000}
      EXTENSION_IDS: ${EXTENSION_IDS:-}
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379
      TURN_SECRET: ${TURN_SECRET}
      TURN_URLS: ${TURN_URLS:-turn:localhost:3478?transport=udp,turn:localhost:3478?transport=tcp}
      STUN_URLS: ${STUN_URLS:-stun:stun.l.google.com:19302}
      ROOM_TTL_SECONDS: ${ROOM_TTL_SECONDS:-86400}
      LOG_LEVEL: ${LOG_LEVEL:-info}
      TRUSTED_PROXIES: ${TRUSTED_PROXIES:-127.0.0.1/8,::1/128,172.30.0.0/24}
    ports: ["127.0.0.1:4000:4000"]             # dev only, host loopback; in production remove and reach via nginx (enables --scale server=N)
    depends_on:
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 3
    stop_grace_period: 30s
    restart: unless-stopped
    networks: [backend]

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      args:
        NEXT_PUBLIC_SERVER_URL: ${NEXT_PUBLIC_SERVER_URL:-http://localhost:4000}
        NEXT_PUBLIC_EXTENSION_ID: ${NEXT_PUBLIC_EXTENSION_ID:-}
    environment:
      PORT: 3000
      HOSTNAME: 0.0.0.0
    ports: ["3000:3000"]                       # same note as server
    depends_on: [server]
    restart: unless-stopped
    networks: [backend]

volumes:
  redis-data:

networks:
  backend:
    ipam:
      config: [{ subnet: 172.30.0.0/24 }]      # pinned so TRUSTED_PROXIES can name it
```

Notes:
- `$$` is compose's escape for a literal `$`. The shell receives `sed -e "s|\${TURN_SECRET}|${TURN_SECRET}|g"`, which replaces the literal placeholder in the template with the env value. Coturn never reads `${...}` itself.
- In production, add nginx either on the host or as one more service: `image: nginx:1.27-alpine`, `ports: ["80:80","443:443"]`, volumes `./nginx/nginx.conf:/etc/nginx/nginx.conf:ro`, `/etc/letsencrypt:/etc/letsencrypt:ro`, `certbot-www:/var/www/certbot:ro`, on network `backend`. Then remove the `ports` of `server` and `web`, and run `docker compose up -d --scale server=2`.
- Coturn's TLS key must be readable by the container user. A certbot `--deploy-hook` copies `fullchain.pem` and `privkey.pem` into `./certs/turn` with mode `0640` and group `65534`, then runs `docker compose restart coturn`. Coturn 4.5.2 and later also reload TLS certificates on `SIGUSR2`, which avoids dropping allocations.

Dockerfile outlines (both multi-stage, `node:24-alpine`, pnpm 9.15.4 through corepack, non-root `USER node`):

| Image | Build stage | Runtime stage |
|---|---|---|
| server | `pnpm install --frozen-lockfile` -> `pnpm turbo run build --filter=@watchparty/server...` -> `pnpm --filter @watchparty/server deploy --prod /out` | `COPY --from=build /out /app`, `CMD ["node","dist/index.js"]`, `EXPOSE 4000` |
| web | `ARG NEXT_PUBLIC_SERVER_URL NEXT_PUBLIC_EXTENSION_ID` -> `ENV` the same -> `pnpm turbo run build --filter=@watchparty/web...` (`output: 'standalone'`, `outputFileTracingRoot` = repo root) | copy `.next/standalone`, `.next/static` -> `apps/web/.next/static`, and `public` -> `apps/web/public`. `CMD ["node","apps/web/server.js"]`, `EXPOSE 3000` |

### 7.3 `nginx/nginx.conf` (WebSocket upgrade, TLS, sticky hash)

```nginx
user  nginx;
worker_processes  auto;
events { worker_connections 4096; }

http {
  include       /etc/nginx/mime.types;
  sendfile      on;
  server_tokens off;
  client_max_body_size 64k;

  # WebSocket upgrade: send "Connection: upgrade" only when the client asked for it
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }

  limit_req_zone  $binary_remote_addr zone=api:10m      rate=60r/m;
  limit_req_zone  $binary_remote_addr zone=metadata:10m rate=30r/m;
  limit_conn_zone $binary_remote_addr zone=perip:10m;

  upstream wp_server {
    hash $binary_remote_addr consistent;          # sticky: Socket.IO polling must hit the same instance
    server server:4000 max_fails=3 fail_timeout=10s;
    keepalive 32;
  }
  upstream wp_web {
    server web:3000;
    keepalive 32;
  }

  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
  ssl_prefer_server_ciphers off;
  ssl_session_cache   shared:SSL:10m;
  ssl_session_timeout 1d;
  ssl_session_tickets off;
  # No OCSP stapling: Let's Encrypt ended OCSP support in 2025.

  # HTTP -> HTTPS + ACME challenges
  server {
    listen 80;
    listen [::]:80;
    server_name watch.example.com api.watch.example.com turn.example.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
  }

  # Web app
  server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name watch.example.com;
    ssl_certificate     /etc/letsencrypt/live/watch.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/watch.example.com/privkey.pem;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    location / {
      proxy_pass http://wp_web;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $remote_addr;      # overwrite, never append client-supplied values
      proxy_set_header X-Forwarded-Proto https;
    }
  }

  # API + Socket.IO
  server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name api.watch.example.com;
    ssl_certificate     /etc/letsencrypt/live/watch.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/watch.example.com/privkey.pem;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;

    location /socket.io/ {
      limit_conn perip 20;
      proxy_pass http://wp_server;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_read_timeout 75s;                 # > pingInterval + pingTimeout (45 s)
      proxy_send_timeout 75s;
      proxy_buffering off;                    # long-polling responses must not be buffered
    }

    location = /api/metadata {
      limit_req zone=metadata burst=10 nodelay;
      limit_req_status 429;
      proxy_pass http://wp_server;
      proxy_set_header Connection "";
    }

    location /api/ {
      limit_req zone=api burst=20 nodelay;
      limit_req_status 429;
      proxy_pass http://wp_server;
      proxy_set_header Connection "";
    }

    location = /healthz {
      access_log off;
      proxy_pass http://wp_server;
      proxy_set_header Connection "";
    }

    location / { return 404; }
  }
}
```

- The certificate covers `watch.example.com`, `api.watch.example.com` and `turn.example.com`: `certbot certonly --webroot -w /var/www/certbot -d watch.example.com -d api.watch.example.com -d turn.example.com`. Renewal runs twice a day (the certbot timer), with a deploy hook that runs `nginx -s reload` and refreshes Coturn's certs (section 7.2).
- `http2 on;` needs nginx 1.25.1 or later. Browsers open the WebSocket over HTTP/1.1 (nginx does not speak RFC 8441), which is what the `Upgrade` mapping expects.
- `server:4000` resolves to every replica IP when nginx starts. Reload nginx after `--scale`.

### 7.4 Firewall and port map

| Port | Proto | Service | Public | Purpose |
|---|---|---|---|---|
| 80 | tcp | nginx | yes | ACME challenge and redirect |
| 443 | tcp | nginx | yes | Web app, API, Socket.IO (wss) |
| 3478 | udp | coturn | yes | STUN and TURN over UDP (preferred) |
| 3478 | tcp | coturn | yes | TURN over TCP (UDP-blocked networks) |
| 5349 | tcp | coturn | yes | TURN over TLS (`turns:`), for strict firewalls |
| 5349 | udp | coturn | yes | TURN over DTLS |
| 49160-49200 | udp | coturn | yes | Relay allocations (41 ports, about 20 relayed pairs; widen with host networking) |
| 3000 | tcp | web | **no** | nginx upstream only |
| 4000 | tcp | server | **no** | nginx upstream only |
| 6379 | tcp | redis | **no** | backend network or loopback only |

---

## 8. Secrets, logging and operations

### 8.1 Secrets

| Secret | Generation | Rotation |
|---|---|---|
| `TURN_SECRET` | `openssl rand -hex 32` | Update `.env`, then `docker compose up -d coturn server`. Credentials already issued fail on their next refresh (at most 1 h). Active allocations finish their current lifetime. Expect a few ICE restarts. |
| `REDIS_PASSWORD` | `openssl rand -hex 32` | Update `.env` and restart redis and server together (a brief reconnect for all sockets). |
| TLS certificates | certbot | automatic, see section 7.3 |

Secrets never go into the image, the repo or logs. `.env` is in `.gitignore`, and `.env.example` documents the keys with dummy values.

### 8.2 Logging (`LOG_LEVEL`, pino through Fastify)

| Log | Do not log |
|---|---|
| Event name, room code, `userId`, ack error code, latency, rate-limit drops, disconnect reason, instance id | Chat text, nicknames at `info` level, SDP, ICE candidates (they contain IP addresses), TURN usernames or credentials, the `userId` query parameter of `/api/turn`, `REDIS_URL` |

Use pino `redact: ['req.query.userId', 'req.headers.authorization', 'req.headers.cookie']`. Client IPs are logged only on rate-limit and brute-force warnings.

### 8.3 Health and monitoring

- `GET /healthz` returns `200 {"ok":true,"redis":"up"|"memory","uptime":s}`. It sends `PING` to Redis with a 500 ms timeout and returns `503` if Redis is down or shutdown has started.
- Alert on: Redis `used_memory / maxmemory > 0.8`, `evicted_keys > 0` (rooms are being evicted early), join-failure rate above 500 per minute, 5xx rate on `/api/*`, and Coturn allocation count close to the relay port count.

---

## 9. Pre-production checklist

**Storage and scaling**
- [ ] `REDIS_URL` is set, `maxmemory` and `volatile-ttl` are configured, AOF is on, Redis is not published publicly, and the ACL or `requirepass` is set.
- [ ] Every app key has a TTL (the CI `SCAN`/`TTL` check passes).
- [ ] State mutations use `WATCH`/`MULTI` with retry, and `seq` is strictly monotonic under 2 instances (integration test with two server processes).
- [ ] The `resolveOverdue()` safety net runs on every instance. Killing the instance that holds the 8 s timer mid-wait still resumes the room within 10 s.
- [ ] nginx sticky hash is configured, and the polling fallback works with `--scale server=2` (WebSocket blocked in DevTools).

**Abuse controls**
- [ ] Every C2S event goes through `take()` before Zod parsing. The limits match section 4.2.
- [ ] `room:join` checks the lockout first, counts `ROOM_NOT_FOUND` and malformed codes, and keys IPv6 by /64.
- [ ] `maxHttpBufferSize` is 65536, and nginx `client_max_body_size` is 64k.
- [ ] `/api/metadata` SSRF tests: `http://127.0.0.1`, `http://[::1]`, `http://169.254.169.254`, a DNS name resolving to `10.x`, a redirect to a private address, and port 8080 are all blocked (422 `INVALID_PAYLOAD`).
- [ ] `/api/turn` returns `FORBIDDEN` without a valid `roomCode` and `userId`, and Coturn's `denied-peer-ip` list is present.

**Browser security**
- [ ] No `dangerouslySetInnerHTML` (lint plus grep gate). Sanitization tests cover bidi overrides, ZWSP, control characters, ZWJ emoji kept, and lengths checked after sanitizing.
- [ ] The CSP header is present with a per-request nonce. YouTube embeds and hls.js workers work under it, and the DevTools console shows no CSP violations.
- [ ] CORS allowlist = `CORS_ORIGINS` + `chrome-extension://{EXTENSION_IDS}`. Polling from a foreign Origin is rejected, and WebSocket from a provider page is accepted.
- [ ] HSTS, `nosniff`, Referrer-Policy and Permissions-Policy are verified with `curl -I`.

**Network**
- [ ] The firewall matches section 7.4. `turnutils_uclient` allocates over UDP, TCP and TLS ([WEBRTC_AND_MEDIA.md section 5.4](./WEBRTC_AND_MEDIA.md#54-verifying-turn)).
- [ ] A WebSocket through nginx stays connected for 10 or more minutes idle (ping/pong under `proxy_read_timeout`).
- [ ] Certificates renew automatically, the nginx reload hook and the Coturn cert copy hook have been tested with `certbot renew --dry-run`.
