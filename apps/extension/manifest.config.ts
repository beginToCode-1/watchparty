import { defineManifest } from '@crxjs/vite-plugin';
import { loadEnv } from 'vite';
import { PROVIDER_MATCHES } from '@watchparty/shared-types';
import pkg from './package.json' with { type: 'json' };

const DEFAULTS = { VITE_SERVER_URL: 'http://localhost:4000', VITE_WEB_URL: 'http://localhost:3000' } as const;

/** VITE_* URLs from apps/extension/.env (or the shell), defaulting to local dev. Throws on an invalid URL. */
export function resolveUrls(mode: string): { serverUrl: string; webUrl: string } {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const pick = (key: keyof typeof DEFAULTS): string => {
    const raw = (env[key] ?? '').trim() || DEFAULTS[key];
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${key} is not a valid URL: "${raw}"`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${key} must be http(s): "${raw}"`);
    return url.origin;
  };
  return { serverUrl: pick('VITE_SERVER_URL'), webUrl: pick('VITE_WEB_URL') };
}

export default defineManifest(({ mode }) => {
  const { serverUrl, webUrl } = resolveUrls(mode);
  return {
    manifest_version: 3,
    name: 'WatchParty',
    version: pkg.version,
    description: 'Watch together in sync on any streaming site.',
    minimum_chrome_version: '120',
    action: { default_popup: 'src/popup/index.html', default_title: 'WatchParty' },
    background: { service_worker: 'src/background.ts', type: 'module' },
    permissions: ['storage', 'tabs', 'activeTab', 'scripting'],
    host_permissions: [...PROVIDER_MATCHES, `${serverUrl}/*`],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    content_scripts: [
      { matches: PROVIDER_MATCHES, js: ['src/content/index.tsx'], run_at: 'document_idle', all_frames: false },
    ],
    externally_connectable: { matches: [`${webUrl}/*`] },
    commands: {
      'toggle-sidebar': { suggested_key: { default: 'Alt+Shift+W' }, description: 'Toggle the WatchParty sidebar' },
    },
  };
});
