import { randomUUID } from 'node:crypto';
import { chatSendSchema, reactionSendSchema, type ChatMessage } from '@watchparty/shared-types';
import { sanitizeChat } from '../../lib/sanitize.js';
import { extractTimestamps } from '../../lib/timestamps.js';
import { AppError } from '../../store/types.js';
import { member, parse, roomChannel, type Ctx } from './context.js';

export function registerChatHandlers(ctx: Ctx): void {
  const { on, socket, store, io } = ctx;

  on('chat:send', 'chat', async (raw) => {
    const p = parse(chatSendSchema, raw);
    const text = sanitizeChat(p.text);
    if (!text) throw new AppError('INVALID_PAYLOAD', 'text: empty after sanitizing');
    const m = member(socket);
    const msg: ChatMessage = {
      id: randomUUID(),
      userId: m.userId,
      nickname: m.nickname,
      text,
      timestamps: extractTimestamps(text),
      at: Date.now(),
    };
    await store.appendChat(m.code, msg);
    io.to(roomChannel(m.code)).emit('chat:message', msg);
    return { id: msg.id };
  });

  on('reaction:send', 'reaction', async (raw) => {
    const { emoji } = parse(reactionSendSchema, raw);
    const m = member(socket);
    if (!(await store.touch(m.code))) throw new AppError('ROOM_NOT_FOUND', 'Room not found');
    const reaction = { id: randomUUID(), userId: m.userId, emoji, at: Date.now() };
    io.to(roomChannel(m.code)).emit('reaction', reaction);
    return { id: reaction.id };
  });
}
