import { z } from 'zod';
import {
  CHAT_TEXT_MAX,
  DRM_PROVIDER_KEYS,
  ERROR_CODES,
  MAX_POSITION_S,
  MEDIA_URL_MAX,
  NICKNAME_MAX,
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  QUEUE_TITLE_MAX,
  REACTION_EMOJIS,
  ROOM_CODE_REGEX,
  SDP_MAX,
  YOUTUBE_ID_REGEX,
} from './constants.js';
import type { Ack } from './events.js';

// Unknown keys are stripped (zod default), not rejected, so newer clients can add optional fields.
// Free text (nickname, chat text, queue title) is sanitized again server-side; see docs/SYNC_PROTOCOL.md §10.2.

// ---------- primitives ----------
export const roomCodeSchema = z.string().trim().toUpperCase().regex(ROOM_CODE_REGEX);
export const userIdSchema = z.string().uuid();
export const nicknameSchema = z.string().trim().min(1).max(NICKNAME_MAX);
export const chatTextSchema = z.string().trim().min(1).max(CHAT_TEXT_MAX);
export const mediaUrlSchema = z.string().trim().min(1).max(MEDIA_URL_MAX);
export const queueTitleSchema = z.string().trim().min(1).max(QUEUE_TITLE_MAX);
export const positionSchema = z.number().finite().min(0).max(MAX_POSITION_S);
export const playbackRateSchema = z.number().finite().min(PLAYBACK_RATE_MIN).max(PLAYBACK_RATE_MAX);
export const emojiSchema = z.enum(REACTION_EMOJIS);
export const sdpSchema = z.string().min(1).max(SDP_MAX);
export const iceCandidateSchema = z.object({
  candidate: z.string().max(4_096), // '' = end-of-candidates
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(1_024).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});
export const mediaKindSchema = z.enum(['hls', 'file', 'youtube', 'local', 'drm', 'unknown']);
export const syncModeSchema = z.enum(['A', 'B', 'C']);
export const drmProviderSchema = z.enum(DRM_PROVIDER_KEYS);
export const errorCodeSchema = z.enum(ERROR_CODES);
export const mediaFlagsSchema = z.object({ audio: z.boolean(), video: z.boolean(), screen: z.boolean() });

// ---------- C2S payloads ----------
export const roomCreateSchema = z.object({ nickname: nicknameSchema, mediaUrl: mediaUrlSchema.optional() });
export const roomJoinSchema = z.object({ roomCode: roomCodeSchema, nickname: nicknameSchema });
export const roomLeaveSchema = z.object({});
export const roomSettingsSchema = z.object({ hostOnlyControl: z.boolean().optional() });
export const syncPingSchema = z.object({ t0: z.number().finite().nonnegative() });
export const playerPlaySchema = z.object({ position: positionSchema });
export const playerPauseSchema = z.object({ position: positionSchema });
export const playerSeekSchema = z.object({ position: positionSchema });
export const playerRateSchema = z.object({ rate: playbackRateSchema });
export const playerBufferingSchema = z.object({ buffering: z.boolean() });
export const playerLoadSchema = z.object({ mediaUrl: mediaUrlSchema });
export const chatSendSchema = z.object({ text: chatTextSchema });
export const reactionSendSchema = z.object({ emoji: emojiSchema });
export const queueAddSchema = z.object({ mediaUrl: mediaUrlSchema, title: queueTitleSchema.optional() });
export const queueRemoveSchema = z.object({ id: z.string().uuid() });
export const queueNextSchema = z.object({});
export const rtcOfferSchema = z.object({ to: userIdSchema, sdp: sdpSchema });
export const rtcAnswerSchema = z.object({ to: userIdSchema, sdp: sdpSchema });
export const rtcIceSchema = z.object({ to: userIdSchema, candidate: iceCandidateSchema });
export const rtcMediaSchema = mediaFlagsSchema;

// ---------- S2C shapes (server-produced; schemas double as types and client-side test fixtures) ----------
export const playbackStateSchema = z.object({
  mediaUrl: z.string().nullable(),
  mode: syncModeSchema.nullable(),
  kind: mediaKindSchema.nullable(),
  paused: z.boolean(),
  position: z.number().finite().min(0),
  rate: z.number().finite().positive(),
  updatedAt: z.number().int(),
  seq: z.number().int().nonnegative(),
  byUserId: userIdSchema.nullable(),
});
export const participantSchema = z.object({
  id: userIdSchema,
  nickname: z.string(),
  isHost: z.boolean(),
  joinedAt: z.number().int(),
  media: mediaFlagsSchema,
});
export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  userId: userIdSchema,
  nickname: z.string(),
  text: z.string(),
  timestamps: z.array(z.number().nonnegative()),
  at: z.number().int(),
});
export const reactionSchema = z.object({
  id: z.string().uuid(),
  userId: userIdSchema,
  emoji: emojiSchema,
  at: z.number().int(),
});
export const queueItemSchema = z.object({
  id: z.string().uuid(),
  mediaUrl: z.string(),
  title: z.string(),
  addedBy: userIdSchema,
  kind: mediaKindSchema,
  mode: syncModeSchema,
});

export const roomStateEventSchema = z.object({ state: playbackStateSchema });
export const roomParticipantsEventSchema = z.object({
  participants: z.array(participantSchema),
  hostId: userIdSchema,
});
export const roomBufferEventSchema = z.object({ waiting: z.boolean(), userIds: z.array(userIdSchema) });
export const queueUpdateEventSchema = z.object({ queue: z.array(queueItemSchema) });
export const roomSettingsEventSchema = z.object({ hostOnlyControl: z.boolean() });
export const rtcOfferRelaySchema = z.object({ from: userIdSchema, sdp: sdpSchema });
export const rtcAnswerRelaySchema = z.object({ from: userIdSchema, sdp: sdpSchema });
export const rtcIceRelaySchema = z.object({ from: userIdSchema, candidate: iceCandidateSchema });
export const errorEventSchema = z.object({ code: errorCodeSchema, message: z.string() });

// ---------- ack data ----------
export const roomCreateAckSchema = z.object({
  roomCode: z.string(),
  userId: userIdSchema,
  state: playbackStateSchema,
  participants: z.array(participantSchema),
});
export const roomJoinAckSchema = z.object({
  roomCode: z.string(),
  userId: userIdSchema,
  hostId: userIdSchema,
  state: playbackStateSchema,
  participants: z.array(participantSchema),
  chat: z.array(chatMessageSchema),
  queue: z.array(queueItemSchema),
});
export const syncPingAckSchema = z.object({ t0: z.number(), t1: z.number().int(), t2: z.number().int() });
export const playerAckSchema = z.object({ seq: z.number().int() });
export const playerLoadAckSchema = z.object({ seq: z.number().int(), kind: mediaKindSchema, mode: syncModeSchema });
export const idAckSchema = z.object({ id: z.string().uuid() });
export const queueAddAckSchema = z.object({ item: queueItemSchema });
export const roomSettingsAckSchema = roomSettingsEventSchema;

// ---------- media classification + HTTP API ----------
export const mediaInfoSchema = z.object({
  kind: mediaKindSchema,
  mode: syncModeSchema,
  url: z.string(),
  youtubeId: z.string().regex(YOUTUBE_ID_REGEX).optional(),
  provider: drmProviderSchema.optional(),
});
export const metadataSchema = z.object({
  title: z.string().nullable(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  siteName: z.string().nullable(),
  kind: mediaKindSchema,
  mode: syncModeSchema,
});
export const metadataQuerySchema = z.object({ url: mediaUrlSchema });
export const iceServerSchema = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export const turnResponseSchema = z.object({ iceServers: z.array(iceServerSchema), ttl: z.number().int() });
export const turnQuerySchema = z.object({ roomCode: roomCodeSchema, userId: userIdSchema });

// ---------- extension bridge (web app -> extension background, docs/EXTENSION_SPEC.md §7.2) ----------
export const bridgeErrorCodeSchema = z.enum(['INVALID_PAYLOAD', 'FORBIDDEN', 'NO_SESSION', 'TAB_ERROR']);
export const httpMediaUrlSchema = mediaUrlSchema.url().refine((u) => /^https?:\/\//i.test(u), {
  message: 'Only http(s) URLs are allowed',
});
export const wpPingSchema = z.object({ type: z.literal('WP_PING') });
export const wpHandoffSchema = z.object({
  type: z.literal('WP_HANDOFF'),
  roomCode: roomCodeSchema,
  nickname: nicknameSchema,
  mediaUrl: httpMediaUrlSchema,
});
export const externalMessageSchema = z.discriminatedUnion('type', [wpPingSchema, wpHandoffSchema]);
export const wpPingReplySchema = z.object({ version: z.string(), hasSession: z.boolean() });
export const wpHandoffReplySchema = z.object({ tabId: z.number().int() });

const bridgeErrorSchema = z.object({
  code: bridgeErrorCodeSchema.catch('TAB_ERROR'),
  message: z.string().catch('The extension refused the request'),
});

/** Validates a BridgeReply envelope from another extension context or the extension itself; null when malformed. */
export function parseBridgeReply<T>(raw: unknown, data: z.ZodType<T, z.ZodTypeDef, unknown>): BridgeReply<T> | null {
  const r = z
    .union([z.object({ ok: z.literal(true), data }), z.object({ ok: z.literal(false), error: bridgeErrorSchema })])
    .safeParse(raw);
  return r.success ? (r.data as BridgeReply<T>) : null;
}

// ---------- inferred types ----------
export type MediaKind = z.infer<typeof mediaKindSchema>;
export type SyncMode = z.infer<typeof syncModeSchema>;
export type MediaFlags = z.infer<typeof mediaFlagsSchema>;
export type ReactionEmoji = z.infer<typeof emojiSchema>;

export type PlaybackState = z.infer<typeof playbackStateSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type Reaction = z.infer<typeof reactionSchema>;
export type QueueItem = z.infer<typeof queueItemSchema>;
export type RoomStateEvent = z.infer<typeof roomStateEventSchema>;
export type RoomBufferEvent = z.infer<typeof roomBufferEventSchema>;
export type RtcOfferRelay = z.infer<typeof rtcOfferRelaySchema>;
export type RtcAnswerRelay = z.infer<typeof rtcAnswerRelaySchema>;
export type RtcIceRelay = z.infer<typeof rtcIceRelaySchema>;

export type RoomJoinResult = z.infer<typeof roomJoinAckSchema>;
export type PlayerAck = z.infer<typeof playerAckSchema>;

export type MediaInfo = z.infer<typeof mediaInfoSchema>;
export type Metadata = z.infer<typeof metadataSchema>;
export type TurnResponse = z.infer<typeof turnResponseSchema>;

export type BridgeErrorCode = z.infer<typeof bridgeErrorCodeSchema>;
export type BridgeReply<T> = Ack<T, BridgeErrorCode>;
export type WpHandoffMessage = z.infer<typeof wpHandoffSchema>;
export type WpPingReply = z.infer<typeof wpPingReplySchema>;
export type WpHandoffReply = z.infer<typeof wpHandoffReplySchema>;
