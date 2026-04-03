/**
 * CLIProxy Local Reverse Proxy
 *
 * Proxies requests from the dashboard to the local CLIProxy service
 * running on 127.0.0.1 inside the same host/container.
 *
 * Mounted at: /api/cliproxy-local/*  ->  http://127.0.0.1:{port}/*
 */

import http from 'http';
import { Request, Response, Router } from 'express';
import { CLIPROXY_DEFAULT_PORT, validatePort } from '../../cliproxy/config/port-manager';
import { loadOrCreateUnifiedConfig } from '../../config/unified-config-loader';
import { requireLocalAccessWhenAuthDisabled } from '../middleware/auth-middleware';

export interface CliproxyLocalProxyDeps {
  enforceAccess?: (req: Request, res: Response) => boolean;
  request?: typeof http.request;
  resolveTargetPort?: () => number;
}

/** Proxy request timeout in milliseconds (30 seconds) */
const PROXY_TIMEOUT_MS = 30_000;

function resolveLocalCliproxyPort(): number {
  try {
    const config = loadOrCreateUnifiedConfig();
    return validatePort(config.cliproxy_server?.local?.port ?? CLIPROXY_DEFAULT_PORT);
  } catch {
    return CLIPROXY_DEFAULT_PORT;
  }
}

function isJsonContentType(contentType: string | string[] | undefined): boolean {
  const values = Array.isArray(contentType) ? contentType : [contentType];
  return values.some((value) => value?.toLowerCase().includes('application/json') === true);
}

function buildProxyBody(req: Request): Buffer | undefined {
  // If express.json() parsed the body (content-type is JSON and req.body is populated),
  // re-serialize it since the original request stream was consumed by the middleware.
  if (
    !isJsonContentType(req.headers['content-type']) ||
    req.body === undefined ||
    req.body === null
  ) {
    return undefined;
  }

  // express.json() sets req.body to the parsed value — re-serialize for the proxy target
  return Buffer.from(JSON.stringify(req.body));
}

function buildProxyHeaders(
  headers: http.IncomingHttpHeaders,
  port: number,
  bodyBuffer?: Buffer
): http.IncomingHttpHeaders {
  const proxyHeaders: http.IncomingHttpHeaders = {
    ...headers,
    host: `127.0.0.1:${port}`,
  };

  delete proxyHeaders.connection;

  if (bodyBuffer) {
    delete proxyHeaders['transfer-encoding'];
    proxyHeaders['content-length'] = String(bodyBuffer.length);
  }

  return proxyHeaders;
}

function sendProxyUnavailable(res: Response): void {
  if (res.headersSent || res.writableEnded) {
    return;
  }

  const body = JSON.stringify({ error: 'CLIProxy is not reachable' });
  res.writeHead(502, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function isEmptyUnavailableProxyResponse(proxyRes: http.IncomingMessage): boolean {
  const contentLength = proxyRes.headers['content-length'];
  const normalizedContentLength = Array.isArray(contentLength) ? contentLength[0] : contentLength;

  return proxyRes.statusCode === 502 && normalizedContentLength === '0';
}

export function createCliproxyLocalProxyRouter(deps: CliproxyLocalProxyDeps = {}): Router {
  const router = Router();
  const enforceAccess =
    deps.enforceAccess ??
    ((req: Request, res: Response) =>
      requireLocalAccessWhenAuthDisabled(
        req,
        res,
        'CLIProxy local proxy requires localhost access when dashboard auth is disabled.'
      ));
  const createRequest = deps.request ?? http.request;
  const resolveTargetPort = deps.resolveTargetPort ?? resolveLocalCliproxyPort;

  router.use((req: Request, res: Response, next) => {
    if (enforceAccess(req, res)) {
      next();
    }
  });

  router.all('/*', (req: Request, res: Response) => {
    const targetPort = resolveTargetPort();
    const targetPath = req.url || '/';
    const bodyBuffer = buildProxyBody(req);

    const proxyReq = createRequest(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        path: targetPath,
        method: req.method,
        headers: buildProxyHeaders(req.headers, targetPort, bodyBuffer),
        timeout: PROXY_TIMEOUT_MS,
      },
      (proxyRes) => {
        // Bun can synthesize an empty 502 response for unreachable localhost
        // connections instead of emitting ECONNREFUSED like Node does.
        if (isEmptyUnavailableProxyResponse(proxyRes)) {
          proxyRes.resume();
          sendProxyUnavailable(res);
          return;
        }

        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        // Manual streaming instead of pipe() for Bun runtime compatibility
        proxyRes.on('data', (chunk: Buffer) => res.write(chunk));
        proxyRes.on('end', () => res.end());
      }
    );

    proxyReq.on('timeout', () => {
      sendProxyUnavailable(res);
      proxyReq.destroy(new Error('CLIProxy request timeout'));
    });

    proxyReq.on('error', () => {
      sendProxyUnavailable(res);
    });

    // Clean up proxy connection when client disconnects.
    // Only use res.on('close') — req.on('close') fires with req.destroyed=true
    // in Bun after body consumption, which would prematurely kill the proxy.
    res.on('close', () => {
      if (!res.writableEnded) {
        proxyReq.destroy();
      }
    });

    if (bodyBuffer) {
      proxyReq.end(bodyBuffer);
      return;
    }

    // For methods without a body (GET, HEAD, etc.) or when express.json()
    // has already consumed the stream, end the request immediately.
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if (!hasBody) {
      proxyReq.end();
      return;
    }

    req.pipe(proxyReq, { end: true });
  });

  return router;
}

export default createCliproxyLocalProxyRouter();
