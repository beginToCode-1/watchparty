import { io, type Socket } from 'socket.io-client';
import {
  type AckCallback,
  type ClientToServerEvents,
  type ErrorCode,
  type RoomJoinResult,
  type ServerToClientEvents,
} from '@watchparty/shared-types';
import { ClockSync, SyncController, expectedPosition, type MediaAdapter, type SyncTransport } from '@watchparty/sync-engine';
import { useRoom } from '@/store/room';
import { SERVER_URL, rememberRoom } from './util';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type C2S = ClientToServerEvents;
type Payload<E extends keyof C2S> = Parameters<C2S[E]>[0];
type AckData<E extends keyof C2S> = NonNullable<Parameters<C2S[E]>[1]> extends AckCallback<infer T> ? T : never;

const ACK_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;

export class RoomError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const ERROR_TEXT: Record<ErrorCode, string> = {
  RATE_LIMITED: 'Slow down a little.',
  INVALID_PAYLOAD: 'That input was not accepted.',
  ROOM_NOT_FOUND: 'This room does not exist or has expired.',
  FORBIDDEN: 'Only the host can do that right now.',
  TOO_MANY_ATTEMPTS: 'Too many failed attempts. Try again in a few minutes.',
  ROOM_FULL: 'This room is full (12 people max).',
  INTERNAL: 'Something went wrong on the server.',
};

/** User-facing text for a room error; INTERNAL / INVALID_PAYLOAD carry the server's own (more specific) message. */
export function errorText(e: { code: ErrorCode; message: string }): string {
  return e.code === 'INTERNAL' || e.code === 'INVALID_PAYLOAD' ? e.message : ERROR_TEXT[e.code];
}

let socket: AppSocket | null = null;
let clock: ClockSync | null = null;
let joinInFlight: { code: string; promise: Promise<RoomJoinResult> } | null = null;
let activeController: SyncController | null = null;

function bindEvents(s: AppSocket, c: ClockSync): void {
  const store = useRoom.getState;
  const set = useRoom.setState;
  s.on('connect', () => {
    c.start();
    set({ connection: 'connected' });
    const { session, handedOff } = store();
    // Reconnect = fresh room:join with the stored nickname; a new userId is issued (CLAUDE.md D7).
    if (session && !handedOff) {
      joinRoom(session.roomCode, session.nickname).catch((err: unknown) => {
        store().leaveSession();
        rememberRoom(null);
        set({ lastError: toError(err) });
      });
    }
  });
  // socket.io flushes emits buffered while offline *before* 'connect' (so before our room:join); the server would
  // answer each with FORBIDDEN "Not in a room". Drop them when the transport reopens.
  s.io.on('open', () => {
    s.sendBuffer = [];
  });
  s.on('disconnect', () => {
    c.stop();
    set({ connection: s.active ? 'reconnecting' : 'idle' });
  });
  s.on('connect_error', () => set({ connection: s.active ? 'reconnecting' : 'error' }));
  // Outside a session only a join in flight can own a room:state (a late one from a left room must not leak in).
  s.on('room:state', (p) => {
    if (store().session || joinInFlight) store().setState(p.state);
  });
  s.on('room:participants', (p) => store().setParticipants(p.participants, p.hostId));
  s.on('room:buffer', (buffer) => set({ buffer }));
  s.on('room:settings', (p) => set({ hostOnlyControl: p.hostOnlyControl }));
  s.on('chat:message', (m) => store().addChat(m));
  s.on('reaction', (r) => store().addReaction(r));
  s.on('queue:update', (p) => set({ queue: p.queue }));
  s.on('error', (lastError) => set({ lastError }));
}

export function getSocket(): AppSocket {
  if (!socket) {
    socket = io(SERVER_URL, { transports: ['websocket'], autoConnect: false });
    clock = new ClockSync(socket);
    bindEvents(socket, clock);
  }
  return socket;
}

export function getClock(): ClockSync {
  getSocket();
  if (!clock) throw new Error('clock not initialised');
  return clock;
}

function ensureConnected(): Promise<AppSocket> {
  const s = getSocket();
  if (s.connected) return Promise.resolve(s);
  useRoom.setState({ connection: 'connecting' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off('connect', onConnect);
      reject(new RoomError('INTERNAL', 'Could not reach the server. Is it running?'));
    }, CONNECT_TIMEOUT_MS);
    const onConnect = () => {
      clearTimeout(timer);
      resolve(s);
    };
    s.once('connect', onConnect);
    s.connect();
  });
}

export function toError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof RoomError) return { code: err.code, message: err.message };
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Unknown error' };
}

/** Emit with ack; resolves `data` or throws RoomError (ack `{ok:false}` or timeout). */
export function request<E extends keyof C2S>(event: E, payload: Payload<E>): Promise<AckData<E>> {
  const s = getSocket();
  // Same reason as syncTransport: fail fast instead of a FORBIDDEN (or a 5 s timeout) after the re-join.
  if (event !== 'room:create' && event !== 'room:join' && (!s.connected || joinInFlight)) {
    return Promise.reject(new RoomError('INTERNAL', 'Reconnecting to the server…'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RoomError('INTERNAL', 'The server did not respond in time.')), ACK_TIMEOUT_MS);
    const ack: AckCallback<AckData<E>> = (res) => {
      clearTimeout(timer);
      if (res.ok) resolve(res.data);
      else reject(new RoomError(res.error.code, res.error.message));
    };
    s.emit(event, ...([payload, ack] as unknown as Parameters<C2S[E]>));
  });
}

/** Fire an action whose failure is shown as the room's error toast. */
export function act<E extends keyof C2S>(event: E, payload: Payload<E>): Promise<AckData<E> | null> {
  return request(event, payload).catch((err: unknown) => {
    useRoom.setState({ lastError: toError(err) });
    return null;
  });
}

export async function createRoom(nickname: string, mediaUrl?: string): Promise<string> {
  await ensureConnected();
  const r = await request('room:create', mediaUrl ? { nickname, mediaUrl } : { nickname });
  useRoom.getState().applyJoin({ ...r, hostId: r.userId, chat: [], queue: [] }, nickname);
  rememberRoom(r.roomCode);
  return r.roomCode;
}

export function joinRoom(code: string, nickname: string): Promise<RoomJoinResult> {
  if (joinInFlight?.code === code) return joinInFlight.promise;
  const promise = (async () => {
    await ensureConnected();
    const r = await request('room:join', { roomCode: code, nickname });
    useRoom.getState().applyJoin(r, nickname);
    rememberRoom(r.roomCode);
    return r;
  })();
  joinInFlight = { code, promise };
  const clear = () => {
    if (joinInFlight?.promise === promise) joinInFlight = null;
  };
  promise.then(clear, clear);
  return promise;
}

/** Leave the room (keeps the socket). `handedOff` keeps the page in its "continued in the extension" state. */
export function leaveRoom(handedOff = false): void {
  const s = getSocket();
  if (s.connected && useRoom.getState().session) s.emit('room:leave', {});
  useRoom.getState().leaveSession();
  if (handedOff) useRoom.setState({ handedOff: true });
}

export function disconnect(): void {
  getSocket().disconnect();
  useRoom.setState({ connection: 'idle' });
}

/** Room position right now (seconds), from the authoritative state and the synced clock. */
export function roomPositionNow(): number {
  const st = useRoom.getState().state;
  return st ? expectedPosition(st, getClock().serverNow()) : 0;
}

/**
 * The socket as the controller's transport, except player:* / player:buffering are dropped while offline or
 * re-joining: they'd come back FORBIDDEN "Not in a room", and onIntentAck would snap playback back with a bogus
 * "Only the host" toast. A dropped intent's ack never fires; the re-join state wins.
 */
function syncTransport(s: AppSocket): SyncTransport {
  const t: SyncTransport = s;
  return {
    emit: (event, ...args) => (s.connected && !joinInFlight ? t.emit(event, ...args) : undefined),
    on: t.on.bind(t) as SyncTransport['on'],
    off: t.off.bind(t) as SyncTransport['off'],
  };
}

/**
 * Drive `adapter` from the room: a SyncController on the shared socket + clock, fed every store state
 * (including re-join acks, whose seq may be lower). Returns the teardown.
 */
export function attachSync(adapter: MediaAdapter): () => void {
  const store = useRoom;
  const ctrl = new SyncController({
    transport: syncTransport(getSocket()),
    clock: getClock(),
    adapter,
    onAutoplayBlocked: () => store.setState({ autoplayBlocked: true }),
    onIntentRejected: (lastError) => store.setState({ lastError }),
  });
  activeController = ctrl;
  const initial = store.getState().state;
  if (initial) ctrl.applyState(initial);
  // Stale seq is dropped by the controller; on reconnect it resets its seq window itself (SYNC_PROTOCOL §7).
  const unsub = store.subscribe((next, prev) => {
    if (next.state && next.state !== prev.state) ctrl.applyState(next.state);
  });
  return () => {
    unsub();
    ctrl.destroy();
    if (activeController === ctrl) activeController = null;
    store.setState({ autoplayBlocked: false });
  };
}

/** From the "click to join playback" overlay (a user gesture). */
export function resumeAfterGesture(): void {
  useRoom.setState({ autoplayBlocked: false });
  activeController?.resumeAfterGesture();
}
