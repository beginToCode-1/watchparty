import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import manifest, { resolveUrls } from './manifest.config';

export default defineConfig(({ mode }) => {
  // One resolution for manifest and code, so defaults apply even without a .env file.
  const { serverUrl, webUrl } = resolveUrls(mode);
  return {
    plugins: [react(), crx({ manifest })],
    define: {
      'import.meta.env.VITE_SERVER_URL': JSON.stringify(serverUrl),
      'import.meta.env.VITE_WEB_URL': JSON.stringify(webUrl),
    },
    server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
  };
});
