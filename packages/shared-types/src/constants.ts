// Single source of truth for every protocol constant (docs/SYNC_PROTOCOL.md §2). Import, never re-type.

// Rooms
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_REGEX = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
export const MAX_PARTICIPANTS = 12;
/** Uppercase, drop characters outside the alphabet, cap at ROOM_CODE_LENGTH (live input filter). */
export const filterCode = (s: string): string =>
  [...s.toUpperCase()]
    .filter((ch) => ROOM_CODE_ALPHABET.includes(ch))
    .join('')
    .slice(0, ROOM_CODE_LENGTH);

export const YOUTUBE_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
// docs/SYNC_PROTOCOL.md §9: @mm:ss or @h:mm:ss, not glued to a word or another tag. Global: reset lastIndex or use matchAll.
export const TIMESTAMP_TAG = /(?<![\w@])@(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?![\w:])/g;

// Text and media limits (lengths are checked again after server-side sanitizing)
export const NICKNAME_MAX = 24;
export const CHAT_TEXT_MAX = 500;
export const CHAT_HISTORY_ON_JOIN = 50;
export const CHAT_HISTORY_MAX = 200;
export const CHAT_TIMESTAMPS_MAX = 10;
export const QUEUE_MAX = 50;
export const QUEUE_TITLE_MAX = 200;
export const MEDIA_URL_MAX = 2048;
export const MAX_POSITION_S = 86_400;
export const PLAYBACK_RATE_MIN = 0.25;
export const PLAYBACK_RATE_MAX = 2;
export const SDP_MAX = 32_768; // fits under the server's maxHttpBufferSize of 64 KiB
export const REACTION_EMOJIS = ['👍', '👎', '😂', '😮', '😢', '😡', '❤️', '🔥', '👏', '🎉', '💀', '🍿'] as const;

// Clock sync
export const CLOCK_BURST_COUNT = 8;
export const CLOCK_INTERVAL_MS = 5_000;
export const CLOCK_WINDOW = 10;
export const CLOCK_PING_TIMEOUT_MS = 2_000;
export const CLOCK_MAX_RTT_MS = 5_000;
export const CLOCK_READY_TIMEOUT_MS = 1_500;

// Drift correction
export const DRIFT_IGNORE_S = 0.08;
export const DRIFT_HARD_SEEK_S = 1.5;
export const DRIFT_HARD_SEEK_COARSE_S = 0.5; // adapters without fine playbackRate (YouTube)
export const DRIFT_GAIN = 0.04 / 1.5; // rate factor per second of drift; the calibration knob
export const CORRECTION_RATE_MIN = 0.96;
export const CORRECTION_RATE_MAX = 1.04;
export const CORRECTION_INTERVAL_MS = 500;

// Echo suppression / intents
export const REMOTE_LOCK_TIMEOUT_MS = 300;
export const INTENT_DEBOUNCE_MS = 150;
export const SEEK_DEBOUNCE_MS = 250;

// Wait-for-buffer
export const BUFFER_GRACE_MS = 400;
export const BUFFER_TIMEOUT_MS = 8_000;
export const RESUME_DELAY_MS = 300;

// TURN credentials lifetime
export const TURN_TTL_SECONDS = 3_600;

// Rate limits: token bucket, `capacity` tokens refilled linearly over `windowMs`.
// Socket buckets are per socket; `metadata` and `turn` are per IP on the HTTP routes.
export const RATE_LIMITS = {
  chat: { capacity: 5, windowMs: 5_000 },
  reaction: { capacity: 10, windowMs: 2_000 },
  player: { capacity: 20, windowMs: 5_000 },
  sync: { capacity: 20, windowMs: 5_000 },
  rtc: { capacity: 200, windowMs: 10_000 },
  metadata: { capacity: 30, windowMs: 60_000 },
  turn: { capacity: 10, windowMs: 60_000 },
} as const;
export const JOIN_FAIL_MAX = 10;
export const JOIN_FAIL_WINDOW_S = 600;
/** room:create per IP per window (Redis `ratelimit:create:{ip}`), shares JOIN_FAIL_WINDOW_S. */
export const CREATE_MAX = 20;
/** A room whose last participant left expires after this (reconnect grace), instead of ROOM_TTL_SECONDS. */
export const EMPTY_ROOM_TTL_S = 300;

export const ERROR_CODES = [
  'RATE_LIMITED',
  'INVALID_PAYLOAD',
  'ROOM_NOT_FOUND',
  'FORBIDDEN',
  'TOO_MANY_ATTEMPTS',
  'ROOM_FULL',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// Mode B providers (docs/WEBRTC_AND_MEDIA.md §1.4, docs/EXTENSION_SPEC.md §3.2).
// `host` is tested against the lowercased hostname; plain domains match themselves and subdomains only
// (`(?:^|\.)`), so `notnetflix.com` and `netflix.com.evil.io` do not match. `matches` feeds the extension manifest.
const AMAZON_TLDS = ['com', 'co.uk', 'de', 'co.jp', 'in', 'ca', 'fr', 'it', 'es', 'com.au', 'com.br', 'com.mx'];
export const DRM_PROVIDERS = [
  { key: 'netflix', host: /(?:^|\.)netflix\.com$/, matches: ['https://*.netflix.com/*'] },
  { key: 'primevideo', host: /(?:^|\.)primevideo\.com$/, matches: ['https://*.primevideo.com/*'] },
  {
    key: 'amazon',
    host: new RegExp(`^(?:www\\.|smile\\.)?amazon\\.(?:${AMAZON_TLDS.map((t) => t.replace(/\./g, '\\.')).join('|')})$`),
    pathPrefix: '/gp/video',
    matches: AMAZON_TLDS.map((t) => `https://www.amazon.${t}/gp/video/*`),
  },
  { key: 'disneyplus', host: /(?:^|\.)disneyplus\.com$/, matches: ['https://*.disneyplus.com/*'] },
  { key: 'hulu', host: /(?:^|\.)hulu\.com$/, matches: ['https://*.hulu.com/*'] },
  { key: 'max', host: /(?:^|\.)max\.com$/, matches: ['https://*.max.com/*'] },
  { key: 'hbomax', host: /(?:^|\.)hbomax\.com$/, matches: ['https://*.hbomax.com/*'] },
  { key: 'appletv', host: /^tv\.apple\.com$/, matches: ['https://tv.apple.com/*'] },
  { key: 'peacock', host: /(?:^|\.)peacocktv\.com$/, matches: ['https://*.peacocktv.com/*'] },
  { key: 'paramountplus', host: /(?:^|\.)paramountplus\.com$/, matches: ['https://*.paramountplus.com/*'] },
  { key: 'crunchyroll', host: /(?:^|\.)crunchyroll\.com$/, matches: ['https://*.crunchyroll.com/*'] },
  {
    key: 'moviebox',
    host: /(?:^|\.)moviebox\.(?:ng|ph)$/,
    matches: ['https://*.moviebox.ng/*', 'https://*.moviebox.ph/*'],
  },
  { key: 'hotstar', host: /(?:^|\.)hotstar\.com$/, matches: ['https://*.hotstar.com/*'] },
  { key: 'jiocinema', host: /(?:^|\.)jiocinema\.com$/, matches: ['https://*.jiocinema.com/*'] },
] as const;
export type DrmProvider = (typeof DRM_PROVIDERS)[number]['key'];
export const DRM_PROVIDER_KEYS = DRM_PROVIDERS.map((p) => p.key) as [DrmProvider, ...DrmProvider[]];
export const PROVIDER_MATCHES: string[] = DRM_PROVIDERS.flatMap((p) => [...p.matches]);
