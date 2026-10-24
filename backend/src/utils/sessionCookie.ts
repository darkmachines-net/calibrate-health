/** @file session Cookie: Clear the browser session cookie with the same name, path, and optional domain used when it was issued. The domain is required for reliable logout on split-origin deployments. */

import type express from 'express';

const DEFAULT_SESSION_COOKIE_NAME = 'cal.sid';

/**
 * Clear the browser session cookie with the same name, path, and optional domain
 * used when it was issued. The domain is required for reliable logout on split-origin deployments.
 */
export function clearSessionCookie(res: express.Response): void {
  const domain = process.env.SESSION_COOKIE_DOMAIN?.trim();
  res.clearCookie(process.env.SESSION_COOKIE_NAME?.trim() || DEFAULT_SESSION_COOKIE_NAME, {
    path: '/',
    ...(domain ? { domain } : {})
  });
}
