/** @file cors: Build request-aware CORS handling from the environment's browser-origin policy. */

import type { IncomingHttpHeaders } from 'node:http';
import type { CorsOptionsDelegate } from 'cors';
import {
  type BrowserOriginPolicy,
  isOriginTrustedByPolicy,
  normalizeBrowserOrigin
} from '../config/cors';

function getHeaderValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

function createCorsError(): Error & { statusCode: number; expose: boolean } {
  return Object.assign(new Error('Not allowed by CORS'), {
    statusCode: 403,
    expose: true
  });
}

/** Build request-aware CORS handling from the environment's browser-origin policy. */
export function createCorsOptionsDelegate(options: {
  originPolicy: BrowserOriginPolicy;
  isProductionOrStaging: boolean;
  useSecureRequestOrigin: boolean;
}): CorsOptionsDelegate {
  return (req, callback) => {
    const requestOrigin = getHeaderValue(req.headers, 'origin');
    if (!requestOrigin) {
      // Non-browser requests (curl, health checks, etc.).
      callback(null, { origin: false });
      return;
    }

    // Same-origin deployments do not need CORS headers. With no deployed allowlist,
    // leave CORS disabled and let the browser enforce same-origin policy.
    if (options.originPolicy.exactOrigins.size === 0 && options.isProductionOrStaging) {
      callback(null, { origin: false });
      return;
    }

    const normalizedOrigin = normalizeBrowserOrigin(requestOrigin);
    if (!normalizedOrigin) {
      callback(createCorsError());
      return;
    }

    const host = getHeaderValue(req.headers, 'host');
    const forwardedProtocol = getHeaderValue(req.headers, 'x-forwarded-proto');
    let protocol = 'http';
    if (forwardedProtocol) {
      protocol = forwardedProtocol.split(',')[0].trim();
    } else if (options.useSecureRequestOrigin) {
      protocol = 'https';
    }
    const apiOrigin = host ? normalizeBrowserOrigin(`${protocol}://${host}`) : null;
    const isSameOrigin = apiOrigin !== null && normalizedOrigin === apiOrigin;

    if (!isSameOrigin && !isOriginTrustedByPolicy(normalizedOrigin, options.originPolicy)) {
      callback(createCorsError());
      return;
    }

    callback(null, {
      origin: true,
      credentials: true,
      exposedHeaders: ['x-request-id']
    });
  };
}
