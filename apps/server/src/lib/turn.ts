import { createHmac } from 'node:crypto';
import { TURN_TTL_SECONDS, type TurnResponse } from '@watchparty/shared-types';

interface TurnInput {
  secret: string;
  userId: string;
  turnUrls: string[];
  stunUrls: string[];
  nowMs?: number;
}

/** coturn `use-auth-secret` (TURN REST API): username `${expiry}:${userId}`, credential base64(HMAC-SHA1). */
export function turnCredentials({ secret, userId, turnUrls, stunUrls, nowMs = Date.now() }: TurnInput): TurnResponse {
  const iceServers: TurnResponse['iceServers'] = [];
  if (stunUrls.length > 0) iceServers.push({ urls: stunUrls });
  if (secret && turnUrls.length > 0) {
    const username = `${Math.floor(nowMs / 1000) + TURN_TTL_SECONDS}:${userId}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
  }
  return { iceServers, ttl: TURN_TTL_SECONDS };
}
