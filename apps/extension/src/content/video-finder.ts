// Universal <video> discovery + per-site seek strategy (docs/EXTENSION_SPEC.md §5).
import { HTMLVideoAdapter } from '@watchparty/sync-engine';

const MIN_W = 200;
const MIN_H = 100;
const ELIGIBLE_MIN = 30;
const SWITCH_FACTOR = 1.25;
const RESCAN_DEBOUNCE_MS = 250;
const POLL_MS = 2000;
const STABLE_SCANS_TO_IDLE = 5;
const AD_ANCESTOR_DEPTH = 8;
// A token preceded by `no-` or followed by `-free` (no-ads, ads-free, video-ad-free) marks the ad-free main player.
const AD_RE =
  /(^|[\s_-])(?<!no[-_])(ad|ads|adv|advert|advertisement|sponsor|preroll|midroll|ima-ad|videoAdUi|ad-showing)(?![-_]free)([\s_-]|$)/i;
const AD_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'imasdk.googleapis.com',
  'googleads.g.doubleclick.net',
  'amazon-adsystem.com',
  'adnxs.com',
  'springserve.com',
  'innovid.com',
  'tremorhub.com',
  'serving-sys.com',
];
// Known per-site ad containers on top of the generic AD_RE token match.
const AD_SELECTORS = [
  '.ytp-ad-module',
  '.video-ads',
  '[data-uia*="ad-break"]',
  '.atvwebplayersdk-ad-container',
  '[class*="adBreak"]',
  '.ima-ad-container',
].join(',');
const MEDIA_EVENTS = ['loadedmetadata', 'play', 'playing', 'emptied', 'durationchange'];

// ---------- candidate collection (§5.2) ----------

function collect(root: Document | ShadowRoot, deep: boolean, out: HTMLVideoElement[] = []): HTMLVideoElement[] {
  out.push(...root.querySelectorAll('video'));
  if (deep) {
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot, deep, out);
  }
  for (const iframe of root.querySelectorAll('iframe')) {
    const doc = iframe.contentDocument; // null cross-origin
    if (doc) collect(doc, deep, out);
  }
  return out;
}

// ---------- filters (§5.3) ----------

const inFullscreen = (v: HTMLVideoElement): boolean => document.fullscreenElement?.contains(v) ?? false;

function isAdContainer(v: HTMLVideoElement): boolean {
  if (v.closest(AD_SELECTORS)) return true;
  let el: Element | null = v.parentElement;
  for (let i = 0; el && i < AD_ANCESTOR_DEPTH; i++, el = el.parentElement) {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (AD_RE.test(el.id) || AD_RE.test(cls)) return true;
  }
  return false;
}

function isAdSource(v: HTMLVideoElement): boolean {
  if (!v.currentSrc || v.currentSrc.startsWith('blob:')) return false;
  try {
    const host = new URL(v.currentSrc).hostname;
    return AD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function passesFilters(v: HTMLVideoElement): boolean {
  if (!v.isConnected) return false;
  if (!inFullscreen(v)) {
    const r = v.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) return false;
    const cs = (v.ownerDocument.defaultView ?? window).getComputedStyle(v);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.1) return false;
  }
  if (v.muted && Number.isFinite(v.duration) && v.duration < 15) return false; // muted short preview
  if (v.loop && v.muted) return false; // hero / background loop
  return !isAdContainer(v) && !isAdSource(v);
}

// ---------- scoring (§5.4) ----------

function visibleFraction(v: Element): number {
  const r = v.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  return vw * vh > 0 ? (w * h) / (vw * vh) : 0;
}

export function scoreVideo(v: HTMLVideoElement, hasProvider: boolean): number {
  let s = 40 * Math.min(1, visibleFraction(v) / 0.25);
  const d = v.duration;
  s += 20 * (d === Infinity ? 0.75 : Number.isFinite(d) ? Math.min(1, Math.log10(Math.max(d, 1)) / Math.log10(3600)) : 0.5);
  if (!v.muted && v.volume > 0) s += 10;
  if (!v.paused || v.currentTime > 0) s += 10;
  if (v.readyState >= 2) s += 10;
  if (v.currentSrc.startsWith('blob:')) s += 5;
  if (v.hasAttribute('controls') || hasProvider) s += 5;
  if (inFullscreen(v)) s += 15;
  return s;
}

function best(deep: boolean, hasProvider: boolean): { video: HTMLVideoElement; score: number } | null {
  let top: { video: HTMLVideoElement; score: number } | null = null;
  for (const v of collect(document, deep)) {
    if (!passesFilters(v)) continue;
    const score = scoreVideo(v, hasProvider);
    if (score >= ELIGIBLE_MIN && (!top || score > top.score)) top = { video: v, score };
  }
  return top;
}

// ---------- tracking (§5.5) ----------

export interface VideoWatcher {
  /** Force a full rescan (sidebar "Retry"). */
  rescan(): void;
  dispose(): void;
}

/** Tracks the primary video across SPA swaps; `onTarget` fires only when the target changes. */
export function watchPrimaryVideo(onTarget: (video: HTMLVideoElement | null) => void, hasProvider: boolean): VideoWatcher {
  let current: HTMLVideoElement | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let stable = 0;

  const scan = (deep: boolean): void => {
    const top = best(deep, hasProvider);
    let next = current;
    if (!current || !passesFilters(current)) next = top?.video ?? null;
    else if (top && top.video !== current && top.score > scoreVideo(current, hasProvider) * SWITCH_FACTOR) next = top.video;
    if (next !== current) {
      current = next;
      stable = 0;
      onTarget(current);
    } else if (current) {
      stable++;
      // Idle only when the MutationObserver (document-level) can see the video's removal: not inside a shadow root
      // or a same-origin iframe, whose swaps it misses.
      if (stable >= STABLE_SCANS_TO_IDLE && poll !== null && current.getRootNode() === document) {
        clearInterval(poll);
        poll = null;
      }
    }
  };

  const wake = (): void => {
    stable = 0;
    if (poll === null) poll = setInterval(() => scan(true), POLL_MS);
  };

  const schedule = (): void => {
    wake();
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      scan(false);
    }, RESCAN_DEBOUNCE_MS);
  };

  const touchesVideo = (n: Node): boolean =>
    n instanceof Element && (n.tagName === 'VIDEO' || n.querySelector('video') !== null || (current !== null && n.contains(current)));

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) if (touchesVideo(n)) return schedule();
      for (const n of r.removedNodes) if (touchesVideo(n)) return schedule();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const onFullscreen = (): void => {
    wake();
    scan(true);
  };
  for (const e of MEDIA_EVENTS) document.addEventListener(e, schedule, { capture: true });
  document.addEventListener('fullscreenchange', onFullscreen);
  window.addEventListener('resize', schedule);
  window.addEventListener('popstate', schedule);

  wake();
  scan(true);

  return {
    rescan: () => {
      current = null;
      onFullscreen();
    },
    dispose: () => {
      observer.disconnect();
      if (debounce !== null) clearTimeout(debounce);
      if (poll !== null) clearInterval(poll);
      for (const e of MEDIA_EVENTS) document.removeEventListener(e, schedule, { capture: true });
      document.removeEventListener('fullscreenchange', onFullscreen);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('popstate', schedule);
    },
  };
}

/** A cross-origin iframe covering at least half the viewport (player we cannot reach, §5.7). */
export function largeCrossOriginIframe(): HTMLIFrameElement | null {
  for (const f of document.querySelectorAll('iframe')) {
    if (f.contentDocument === null && f.src.startsWith('http') && visibleFraction(f) >= 0.5) return f;
  }
  return null;
}

// ---------- per-site seek strategy (§5.6) ----------

const SEEK_VERIFY_MS = 1500;
const SEEK_TOLERANCE_S = 1;

/**
 * Netflix: writing `currentTime` triggers player error M7375, so seeks go to the MAIN-world bridge (injected by the
 * background) as a `wp:seek` CustomEvent carrying milliseconds. Best effort: the bridge uses an undocumented API,
 * so we verify the element actually moved and report failure (sidebar shows "Seek manually to …").
 */
class MainWorldSeekAdapter extends HTMLVideoAdapter {
  private verify: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onSeekFailed: (seconds: number) => void,
  ) {
    super(video);
  }

  override seek(seconds: number): void {
    const d = this.getDuration();
    const t = Math.max(0, d === null ? seconds : Math.min(seconds, d));
    document.dispatchEvent(new CustomEvent('wp:seek', { detail: Math.round(t * 1000) }));
    if (this.verify !== null) clearTimeout(this.verify);
    this.verify = setTimeout(() => {
      this.verify = null;
      const v = this.video;
      const expected = t + (v.paused ? 0 : (SEEK_VERIFY_MS / 1000) * v.playbackRate);
      if (!v.seeking && Math.abs(v.currentTime - expected) > SEEK_TOLERANCE_S) this.onSeekFailed(t);
    }, SEEK_VERIFY_MS);
  }

  override destroy(): void {
    if (this.verify !== null) clearTimeout(this.verify);
    this.verify = null;
    super.destroy();
  }
}

export function createAdapter(
  video: HTMLVideoElement,
  provider: string | null,
  onSeekFailed: (seconds: number) => void,
): HTMLVideoAdapter {
  return provider === 'netflix' ? new MainWorldSeekAdapter(video, onSeekFailed) : new HTMLVideoAdapter(video);
}

/** YouTube plays ads in the main <video>; while this is true the content script reports buffering (§5.6). */
export function isSiteAdShowing(): boolean {
  return document.querySelector('#movie_player.ad-showing') !== null;
}
