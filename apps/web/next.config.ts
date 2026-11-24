import type { NextConfig } from 'next';

// CSP itself is per-request (nonce) and lives in src/middleware.ts; these are the static headers
// from docs/DEVOPS_AND_SECURITY.md §6.3.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value:
      'camera=(self), microphone=(self), display-capture=(self), picture-in-picture=(self), ' +
      'autoplay=(self "https://www.youtube.com"), fullscreen=(self "https://www.youtube.com"), ' +
      'encrypted-media=(self "https://www.youtube.com"), geolocation=(), payment=(), usb=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Only the Docker image needs the standalone server; `next start` (pnpm party) warns when it is set.
  output: process.env.NEXT_STANDALONE === '1' ? 'standalone' : undefined,
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
