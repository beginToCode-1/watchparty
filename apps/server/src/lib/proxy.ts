import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

/** Copy without hop-by-hop headers (RFC 9110 §7.6.1), including any the Connection header names. */
function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const drop = new Set([...HOP_BY_HOP, ...(headers.connection ?? '').split(',').map((h) => h.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !drop.has(k)));
}

export interface Forwarded {
  /** Client IP, host and scheme as already resolved under TRUSTED_PROXIES (Fastify's req.ip / host / protocol). */
  for: string;
  host: string;
  proto: string;
}

/**
 * Stream one request to `upstream` (an http origin) and its response back. X-Forwarded-* are overwritten, never
 * appended, like nginx's `$remote_addr` policy. Upstream failure before headers => 502 plain text.
 */
export function proxyRequest(upstream: URL, req: IncomingMessage, res: ServerResponse, fwd: Forwarded, onError: (err: Error) => void): void {
  const headers = {
    ...endToEnd(req.headers),
    'x-forwarded-for': fwd.for,
    'x-forwarded-host': fwd.host,
    'x-forwarded-proto': fwd.proto,
  };
  const up = http.request(
    { host: upstream.hostname.replace(/^\[|\]$/g, ''), port: upstream.port || 80, method: req.method, path: req.url, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, endToEnd(upRes.headers));
      upRes.on('error', () => res.destroy()); // upstream died mid-body
      upRes.pipe(res);
    },
  );
  up.on('error', (err) => {
    onError(err);
    if (res.headersSent) return void res.destroy();
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Bad gateway: the web app is not reachable\n');
  });
  // Client went away mid-flight: stop the upstream request too.
  res.on('close', () => {
    if (!res.writableFinished) up.destroy();
  });
  req.pipe(up);
}
