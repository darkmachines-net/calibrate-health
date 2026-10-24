/** @file Host-safe Expo preview HTTP server with strict static paths, route fallbacks, and cache headers. */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST_DIR = path.resolve(SCRIPT_DIR, '..', 'mobile', 'dist');
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function isBackendPath(pathname) {
  return /^\/(?:api|auth)(?:\/|$)/.test(pathname);
}

/** Resolve requests without letting SPA fallback mask missing backend routes or static files. */
export function resolveExpoWebRequest(distDir, encodedPathname) {
  let pathname;
  try {
    pathname = decodeURIComponent(encodedPathname);
  } catch {
    return { status: 400 };
  }
  if (pathname.includes('\0')) return { status: 400 };
  const segments = pathname.split('/');
  if (segments.includes('..')) return { status: 400 };
  if (isBackendPath(pathname)) return { status: 404 };

  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = path.resolve(distDir, relativePath);
  const resolvedDist = path.resolve(distDir);
  if (candidate !== resolvedDist && !candidate.startsWith(`${resolvedDist}${path.sep}`)) return { status: 400 };
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return { status: 200, filePath: candidate, spaFallback: false };
  }
  if (path.posix.extname(pathname) === '') {
    const routeFile = `${candidate.replace(/[\\/]$/, '')}.html`;
    if (fs.existsSync(routeFile) && fs.statSync(routeFile).isFile()) {
      return { status: 200, filePath: routeFile, spaFallback: false };
    }
    const notFoundFile = path.join(resolvedDist, '+not-found.html');
    const fallbackFile = fs.existsSync(notFoundFile) && fs.statSync(notFoundFile).isFile()
      ? notFoundFile
      : path.join(resolvedDist, 'index.html');
    return { status: 200, filePath: fallbackFile, spaFallback: true };
  }
  return { status: 404 };
}

function cacheControl(filePath) {
  const fileName = path.basename(filePath);
  if (fileName.endsWith('.html') || ['sw.js', 'manifest.webmanifest'].includes(fileName)) return 'no-cache';
  if (/[.-][a-f0-9]{8,}[.-]/i.test(fileName)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

/** Serves exported Expo files for GET/HEAD requests with the production route-resolution policy. */
export function createExpoWebStaticServer({ distDir = DEFAULT_DIST_DIR } = {}) {
  return http.createServer((request, response) => {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const resolved = resolveExpoWebRequest(distDir, requestUrl.pathname);
    if (resolved.status !== 200 || !resolved.filePath) {
      response.writeHead(resolved.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(resolved.status === 400 ? 'Bad request' : 'Not found');
      return;
    }
    const extension = path.extname(resolved.filePath).toLowerCase();
    response.writeHead(200, {
      'Cache-Control': cacheControl(resolved.filePath),
      'Content-Type': MIME_TYPES.get(extension) ?? 'application/octet-stream',
      ...(resolved.spaFallback ? { 'X-Calibrate-SPA-Fallback': '1' } : {}),
    });
    if (method === 'HEAD') {
      response.end();
      return;
    }
    const stream = fs.createReadStream(resolved.filePath);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const portIndex = process.argv.indexOf('--port');
  const portText = portIndex >= 0 ? process.argv[portIndex + 1] : '4174';
  if (!/^\d+$/.test(portText || '')) throw new Error(`Invalid Expo web preview port: ${String(portText)}`);
  const server = createExpoWebStaticServer();
  server.listen(Number(portText), '127.0.0.1', () => {
    console.log(`Expo web static preview listening at http://127.0.0.1:${portText}`);
  });
  const shutdown = () => {
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
