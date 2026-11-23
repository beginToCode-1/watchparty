import { rtcAnswerSchema, rtcIceSchema, rtcMediaSchema, rtcOfferSchema } from '@watchparty/shared-types';
import { AppError } from '../../store/types.js';
import { broadcastParticipants, member, parse, userChannel, type Ctx } from './context.js';

/** Signaling relay: only to another participant of the sender's own room, addressed by userId. */
export function registerRtcHandlers(ctx: Ctx): void {
  const { on, socket, store, io } = ctx;

  const target = async (to: string) => {
    const m = member(socket);
    if (to === m.userId || !(await store.hasParticipant(m.code, to))) {
      throw new AppError('FORBIDDEN', 'Target is not in your room');
    }
    return { from: m.userId, to: io.to(userChannel(to)) };
  };

  on('rtc:offer', 'rtc', async (raw) => {
    const p = parse(rtcOfferSchema, raw);
    const t = await target(p.to);
    t.to.emit('rtc:offer', { from: t.from, sdp: p.sdp });
    return null;
  });

  on('rtc:answer', 'rtc', async (raw) => {
    const p = parse(rtcAnswerSchema, raw);
    const t = await target(p.to);
    t.to.emit('rtc:answer', { from: t.from, sdp: p.sdp });
    return null;
  });

  on('rtc:ice', 'rtc', async (raw) => {
    const p = parse(rtcIceSchema, raw);
    const t = await target(p.to);
    t.to.emit('rtc:ice', { from: t.from, candidate: p.candidate });
    return null;
  });

  on('rtc:media', 'rtc', async (raw) => {
    const media = parse(rtcMediaSchema, raw);
    const m = member(socket);
    if (!(await store.setParticipantMedia(m.code, m.userId, media))) throw new AppError('FORBIDDEN', 'Not in a room');
    const [room, list] = await Promise.all([store.getRoom(m.code), store.listParticipants(m.code)]);
    if (room) broadcastParticipants(ctx, m.code, list, room.meta.hostId);
    return null;
  });
}
