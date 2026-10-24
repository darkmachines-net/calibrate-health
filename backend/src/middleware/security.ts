/** @file security: Build narrow abuse controls without throttling normal food, weight, or sync traffic. */

import type { RequestHandler } from 'express';
import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { isOriginTrustedByPolicy } from '../config/cors';

const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const CLIENT_DIAGNOSTICS_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const CLIENT_DIAGNOSTICS_RATE_LIMIT_MAX = 120;
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type AuthRateLimiters = {
  login: RateLimitRequestHandler;
  registration: RateLimitRequestHandler;
  refresh: RateLimitRequestHandler;
  passwordChange: RateLimitRequestHandler;
  accountEmailRequest: RateLimitRequestHandler;
  accountTokenConfirm: RateLimitRequestHandler;
  pairingIssueIp: RateLimitRequestHandler;
  pairingIssue: RateLimitRequestHandler;
  pairingExchange: RateLimitRequestHandler;
};

/** Build narrow abuse controls without throttling normal food, weight, or sync traffic. */
export function createAuthRateLimiters(): AuthRateLimiters {
  const createLimiter = (limit: number, message: string): RateLimitRequestHandler =>
    rateLimit({
      windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { message }
    });

  return {
    login: createLimiter(20, 'Too many login attempts. Try again later.'),
    registration: createLimiter(10, 'Too many registration attempts. Try again later.'),
    refresh: createLimiter(120, 'Too many token refresh attempts. Try again later.'),
    passwordChange: createLimiter(10, 'Too many password change attempts. Try again later.'),
    accountEmailRequest: createLimiter(5, 'Too many email requests. Try again later.'),
    accountTokenConfirm: createLimiter(20, 'Too many account link attempts. Try again later.'),
    pairingIssueIp: createLimiter(60, 'Too many Wear pairing requests from this network. Try again later.'),
    pairingIssue: rateLimit({
      windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
      limit: 20,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { message: 'Too many Wear pairing requests. Try again later.' },
      // This limiter runs after bearer auth. Invalid/anonymous traffic is rejected elsewhere and
      // must not consume an authenticated phone session's pairing budget.
      skip: (_req, res) => typeof res.locals.mobileAuthSessionId !== 'number',
      keyGenerator: (_req, res) => `mobile-session:${res.locals.mobileAuthSessionId}`
    }),
    pairingExchange: createLimiter(30, 'Too many Wear pairing attempts. Try again later.')
  };
}

/** Anonymous diagnostics accept only fixed tuples, with an IP ceiling for aggregate integrity. */
export function createClientDiagnosticsRateLimiter(options: {
  windowMs?: number;
  limit?: number;
} = {}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs ?? CLIENT_DIAGNOSTICS_RATE_LIMIT_WINDOW_MS,
    limit: options.limit ?? CLIENT_DIAGNOSTICS_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many client diagnostics. Try again later.' },
    handler: (_req, res, _next, options) => {
      res.setHeader('cache-control', 'no-store');
      res.status(options.statusCode).send(options.message);
    }
  });
}

function normalizedOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Reject browser cross-origin mutations before they reach cookie-authenticated routes.
 *
 * SameSite cookies remain the first CSRF boundary. This explicit Origin check also protects
 * deployments that use SameSite=None and same-site sibling hosts that browsers do not classify
 * as cross-site. Native clients do not send Origin and authenticate with bearer tokens.
 */
export function createBrowserMutationOriginGuard(options: {
  trustedOrigins: ReadonlySet<string>;
  useSecureRequestOrigin: boolean;
  allowDevelopmentLoopbackOrigins?: boolean;
}): RequestHandler {
  const originPolicy = {
    exactOrigins: options.trustedOrigins,
    allowDevelopmentLoopbackOrigins: options.allowDevelopmentLoopbackOrigins ?? false
  };

  return (req, res, next) => {
    if (SAFE_HTTP_METHODS.has(req.method.toUpperCase())) return next();
    if (typeof res.locals.mobileAuthSessionId === 'number') return next();

    const requestOrigin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site')?.trim().toLowerCase();
    if (!requestOrigin) {
      // Browsers send Origin for fetch/form mutations. Keep non-browser self-host tooling working,
      // while rejecting an explicit browser signal that says the request is cross-site.
      if (fetchSite === 'cross-site') {
        return res.status(403).json({ message: 'Cross-origin mutation is not allowed' });
      }
      return next();
    }

    const origin = normalizedOrigin(requestOrigin);
    const host = req.get('host');
    const forwardedProtocol = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const protocol = forwardedProtocol || (options.useSecureRequestOrigin ? 'https' : req.protocol);
    const apiOrigin = host ? normalizedOrigin(`${protocol}://${host}`) : null;
    const isAllowedOrigin = origin && (origin === apiOrigin || isOriginTrustedByPolicy(origin, originPolicy));
    if (isAllowedOrigin) return next();

    return res.status(403).json({ message: 'Cross-origin mutation is not allowed' });
  };
}
