import type { ChatMessage, ErrorCode, MediaFlags, PlaybackState, QueueItem } from '@watchparty/shared-types';

export interface RoomMeta {
  code: string;
  hostId: string;
  hostOnlyControl: boolean;
}

/** Wait-for-buffer record (docs/SYNC_PROTOCOL.md §8.2). Effective set = userIds - ignored. */
export interface BufferRecord {
  active: boolean;
  userIds: string[];
  ignored: string[];
  startedAt: number;
  resumeOnClear: boolean;
  /** userId -> until when it may not start a wait / stays ignored. Absent in records written before it existed. */
  cooldown?: Record<string, number>;
}

export interface RoomRecord {
  meta: RoomMeta;
  state: PlaybackState;
  buffer: BufferRecord;
}

export interface ParticipantRecord {
  id: string;
  nickname: string;
  joinedAt: number;
  media: MediaFlags;
}

/** Thrown by handlers (and from inside `mutateRoom` fns, which aborts the write) to reply with an error code. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface RoomStore {
  readonly kind: 'memory' | 'redis';
  /** false when the code is already taken. */
  createRoom(room: RoomRecord, host: ParticipantRecord): Promise<boolean>;
  getRoom(code: string): Promise<RoomRecord | null>;
  /**
   * Atomic read-modify-write of meta/state/buffer. `fn` mutates the record in place and must be free of side effects
   * (it may run more than once on contention). Throwing from `fn` aborts without writing. null = room not found.
   */
  mutateRoom<T>(code: string, fn: (room: RoomRecord) => T): Promise<{ room: RoomRecord; result: T } | null>;
  /** Refresh the TTL of every room key; false when the room does not exist. */
  touch(code: string): Promise<boolean>;

  addParticipant(code: string, p: ParticipantRecord, max: number): Promise<'ok' | 'not_found' | 'full'>;
  removeParticipant(code: string, userId: string): Promise<boolean>;
  /** Ordered by joinedAt, ties by id. */
  listParticipants(code: string): Promise<ParticipantRecord[]>;
  hasParticipant(code: string, userId: string): Promise<boolean>;
  setParticipantMedia(code: string, userId: string, media: MediaFlags): Promise<boolean>;

  appendChat(code: string, msg: ChatMessage): Promise<void>;
  recentChat(code: string, n: number): Promise<ChatMessage[]>;

  getQueue(code: string): Promise<QueueItem[]>;
  /** false when the queue already holds `max` items. */
  pushQueue(code: string, item: QueueItem, max: number): Promise<boolean>;
  removeQueue(code: string, id: string): Promise<boolean>;
  popQueue(code: string): Promise<QueueItem | null>;

  /** Shorten every room key's TTL (empty room). Later activity refreshes it back to the full TTL. */
  expireRoom(code: string, seconds: number): Promise<void>;

  /** Fixed-window counter (`ratelimit:*`): atomic increment, TTL set on the first hit only. Returns the new count. */
  incrCounter(key: string, windowS: number): Promise<number>;
  /** Refund one hit of a live counter; no-op once it expired. */
  decrCounter(key: string): Promise<void>;

  /** Health probe: resolves true when the backing store answers. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const byJoinOrder = (a: ParticipantRecord, b: ParticipantRecord) =>
  a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
