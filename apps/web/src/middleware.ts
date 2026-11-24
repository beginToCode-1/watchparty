import { NextResponse, type NextRequest } from 'next/server';

// Per-request nonce CSP (docs/DEVOPS_AND_SECURITY.md §6.2). Next reads the nonce from the request's CSP header
// and stamps it on its own inline/bootstrap scripts; everything else loads through 'strict-dynamic'.
// Empty = same origin (the server proxies this app): CSP3 'self' already covers same-host ws:/wss:.
const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? '';

function serverOrigins(): string {
  if (!SERVER_URL) return '';
  try {
    const u = new URL(SERVER_URL);
    const ws = `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
    return `${u.origin} ${ws}`;
  } catch {
    return '';
  }
}

export function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== 'production';
  // Behind the tunnel + server proxy the hop to Next is plain http; the original scheme is in X-Forwarded-Proto.
  const https = req.nextUrl.protocol === 'https:' || req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    `media-src 'self' blob: https:${dev ? ' http:' : ''}`,
    `connect-src 'self' ${serverOrigins()} https:${dev ? ' http:' : ''}`, // empty origins = a harmless double space
    'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Only on an https page, and not when a split-port http server is configured (its calls would be force-upgraded).
    ...(!dev && https && !SERVER_URL.startsWith('http:') ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

export const config = {
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico).*)', missing: [{ type: 'header', key: 'next-router-prefetch' }] }],
};
