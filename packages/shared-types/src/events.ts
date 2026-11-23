import type { z } from 'zod';
import type { ErrorCode } from './constants.js';
import type * as S from './schemas.js';

export type Ack<T, C = ErrorCode> = { ok: true; data: T } | { ok: false; error: { code: C; message: string } };
export type AckCallback<T> = (res: Ack<T>) => void;

type In<T extends z.ZodTypeAny> = z.input<T>;
type Out<T extends z.ZodTypeAny> = z.output<T>;
type Cb<T> = AckCallback<T>;

export interface ClientToServerEvents {
  'room:create': (p: In<typeof S.roomCreateSchema>, ack?: Cb<Out<typeof S.roomCreateAckSchema>>) => void;
  'room:join': (p: In<typeof S.roomJoinSchema>, ack?: Cb<Out<typeof S.roomJoinAckSchema>>) => void;
  'room:leave': (p: In<typeof S.roomLeaveSchema>, ack?: Cb<null>) => void;
  'room:settings': (p: In<typeof S.roomSettingsSchema>, ack?: Cb<Out<typeof S.roomSettingsAckSchema>>) => void;
  'sync:ping': (p: In<typeof S.syncPingSchema>, ack?: Cb<Out<typeof S.syncPingAckSchema>>) => void;
  'player:play': (p: In<typeof S.playerPlaySchema>, ack?: Cb<Out<typeof S.playerAckSchema>>) => void;
  'player:pause': (p: In<typeof S.playerPauseSchema>, ack?: Cb<Out<typeof S.playerAckSchema>>) => void;
  'player:seek': (p: In<typeof S.playerSeekSchema>, ack?: Cb<Out<typeof S.playerAckSchema>>) => void;
  'player:rate': (p: In<typeof S.playerRateSchema>, ack?: Cb<Out<typeof S.playerAckSchema>>) => void;
  'player:buffering': (p: In<typeof S.playerBufferingSchema>, ack?: Cb<null>) => void;
  'player:load': (p: In<typeof S.playerLoadSchema>, ack?: Cb<Out<typeof S.playerLoadAckSchema>>) => void;
  'chat:send': (p: In<typeof S.chatSendSchema>, ack?: Cb<Out<typeof S.idAckSchema>>) => void;
  'reaction:send': (p: In<typeof S.reactionSendSchema>, ack?: Cb<Out<typeof S.idAckSchema>>) => void;
  'queue:add': (p: In<typeof S.queueAddSchema>, ack?: Cb<Out<typeof S.queueAddAckSchema>>) => void;
  'queue:remove': (p: In<typeof S.queueRemoveSchema>, ack?: Cb<null>) => void;
  'queue:next': (p: In<typeof S.queueNextSchema>, ack?: Cb<Out<typeof S.playerLoadAckSchema>>) => void;
  'rtc:offer': (p: In<typeof S.rtcOfferSchema>, ack?: Cb<null>) => void;
  'rtc:answer': (p: In<typeof S.rtcAnswerSchema>, ack?: Cb<null>) => void;
  'rtc:ice': (p: In<typeof S.rtcIceSchema>, ack?: Cb<null>) => void;
  'rtc:media': (p: In<typeof S.rtcMediaSchema>, ack?: Cb<null>) => void;
}
export type C2SEventName = keyof ClientToServerEvents;

export interface ServerToClientEvents {
  'room:state': (p: Out<typeof S.roomStateEventSchema>) => void;
  'room:participants': (p: Out<typeof S.roomParticipantsEventSchema>) => void;
  'room:buffer': (p: Out<typeof S.roomBufferEventSchema>) => void;
  'room:settings': (p: Out<typeof S.roomSettingsEventSchema>) => void;
  'chat:message': (p: Out<typeof S.chatMessageSchema>) => void;
  reaction: (p: Out<typeof S.reactionSchema>) => void;
  'queue:update': (p: Out<typeof S.queueUpdateEventSchema>) => void;
  'rtc:offer': (p: Out<typeof S.rtcOfferRelaySchema>) => void;
  'rtc:answer': (p: Out<typeof S.rtcAnswerRelaySchema>) => void;
  'rtc:ice': (p: Out<typeof S.rtcIceRelaySchema>) => void;
  error: (p: Out<typeof S.errorEventSchema>) => void;
}

// Server-to-server events (redis adapter `serverSideEmit`): none are used.
export type InterServerEvents = Record<never, never>;

// `socket.data` on the server. Set on connection (`ip`) and on create/join (the rest).
export interface SocketData {
  ip: string;
  userId?: string;
  roomCode?: string;
  nickname?: string;
}
