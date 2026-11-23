import { CHAT_TEXT_MAX, NICKNAME_MAX, QUEUE_TITLE_MAX } from '@watchparty/shared-types';

// C0 + DEL + C1 control chars, bidi embeddings/overrides/isolates. HTML escaping is the renderer's job.
const STRIP = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

export function sanitizeText(input: string): string {
  return input.replace(/[\r\n\t]/g, ' ').replace(STRIP, '').trim();
}

/** Sanitized text, or null when the result is empty or longer than `max`. */
function sanitizeBounded(input: string, max: number): string | null {
  const s = sanitizeText(input);
  return s.length >= 1 && s.length <= max ? s : null;
}

export const sanitizeNickname = (s: string) => sanitizeBounded(s, NICKNAME_MAX);
export const sanitizeChat = (s: string) => sanitizeBounded(s, CHAT_TEXT_MAX);
export const sanitizeTitle = (s: string) => sanitizeBounded(s, QUEUE_TITLE_MAX);
