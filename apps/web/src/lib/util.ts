import { NICKNAME_MAX } from '@watchparty/shared-types';

/**
 * Server base URL. NEXT_PUBLIC_SERVER_URL only for the split-port dev setup (`next dev` on :3000); empty means the
 * server proxies this app, so it is this page's own origin (a tunnel URL that changes every run). Browser-only.
 */
export function serverUrl(): string {
  return process.env.NEXT_PUBLIC_SERVER_URL || window.location.origin;
}

/** href/src guard (docs/DEVOPS_AND_SECURITY.md §5.2): only http(s), or blob: when `allowBlob`. */
export function safeHttpUrl(raw: string | null | undefined, allowBlob = false): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    if (allowBlob && u.protocol === 'blob:') return u.href;
  } catch {
    return null;
  }
  return null;
}

/** localStorage read; storage can be disabled or throw (private mode, quota). */
export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the preference just isn't remembered.
  }
}

export function readNickname(): string {
  const v = readPref('wp:nickname');
  return v && v.trim().length > 0 ? v.trim().slice(0, NICKNAME_MAX) : '';
}

/** Session flag so a reload of /room/CODE rejoins without the nickname prompt (invite links still prompt). */
export function rememberRoom(code: string | null): void {
  try {
    if (code) window.sessionStorage.setItem('wp:room', code);
    else window.sessionStorage.removeItem('wp:room');
  } catch {
    // Storage unavailable: a reload shows the nickname prompt.
  }
}

export function rememberedRoom(): string | null {
  try {
    return window.sessionStorage.getItem('wp:room');
  } catch {
    return null;
  }
}
