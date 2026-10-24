/** @file mobile Auth: Authenticate native bearer tokens before route-level `req.isAuthenticated()` guards run. */

import type { NextFunction, Request, Response } from 'express';
import { authenticateMobileAccessToken } from '../services/mobileAuth';

const isWearSessionEndpointAllowed = (req: Request, sessionId: number): boolean => {
  if (req.method === 'POST' && (
    req.path === '/auth/mobile/refresh' ||
    req.path === '/auth/mobile/logout'
  )) return true;
  if (req.path === '/api/v1/watch' || req.path.startsWith('/api/v1/watch/')) return true;

  if (req.method === 'DELETE') {
    const match = req.path.match(/^\/auth\/mobile\/sessions\/(\d+)$/);
    return Boolean(match && Number(match[1]) === sessionId);
  }
  return false;
};

/**
 * Authenticate native bearer tokens before route-level `req.isAuthenticated()` guards run.
 *
 * Existing browser sessions continue through Passport unchanged; native requests get a hydrated
 * `req.user` and a request-local authenticated predicate.
 */
export const authenticateMobileBearerToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authorization = req.get('authorization');
  if (!authorization) {
    return next();
  }

  const result = await authenticateMobileAccessToken(authorization);
  if (!result.ok) {
    // Logout can revoke by refresh token even after the short-lived bearer token expires.
    if (req.method === 'POST' && req.path === '/auth/mobile/logout') {
      return next();
    }
    return res.status(result.status).json({ message: result.message });
  }

  req.user = result.user;
  req.isAuthenticated = (() => true) as Request['isAuthenticated'];
  res.locals.mobileAuthSessionId = result.sessionId;
  res.locals.mobileDeviceId = result.deviceId;
  res.locals.mobileDevicePlatform = result.devicePlatform;
  if (result.devicePlatform === 'wear_os' && !isWearSessionEndpointAllowed(req, result.sessionId)) {
    return res.status(403).json({
      message: 'Wear OS session is not allowed for this endpoint',
      code: 'WEAR_SESSION_SCOPE_DENIED',
      retryable: false
    });
  }
  return next();
};
