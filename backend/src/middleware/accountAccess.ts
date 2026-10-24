/** @file account Access: Recheck authenticated account gates for protected routes and reject restricted access without clearing the session. */

import type { NextFunction, Request, Response } from 'express';
import { isAuthenticatedUser } from './authenticatedUser';
import { getAccountAccess, type AccountAccess } from '../services/accountAccess';
import { logSafeOperationalError } from '../observability';

const AUTH_ALLOWED_PATHS = new Set([
  '/auth/login',
  '/auth/mobile/login',
  '/auth/me',
  '/auth/logout',
  '/auth/mobile/logout',
  '/auth/mobile/refresh',
  '/auth/email-verification/resend',
  '/auth/email-verification/confirm',
  '/auth/password-reset/request',
  '/auth/password-reset/confirm'
]);

/** Allow only recovery, legal, portability and supporting requests while normal account access is restricted. */
const isRestrictedPathAllowed = (req: Request): boolean => {
  if (req.method === 'OPTIONS') return true;
  if (AUTH_ALLOWED_PATHS.has(req.path)) return true;
  if (/^\/api(?:\/v1)?\/legal\/(?:status|acceptance)$/.test(req.path)) return true;
  if (/^\/api(?:\/v1)?\/client-config\/?$/.test(req.path) && req.method === 'GET') return true;
  if (/^\/api(?:\/v1)?\/client-diagnostics\/?$/.test(req.path) && req.method === 'POST') return true;
  if (/^\/api(?:\/v1)?\/user\/account\/export\/?$/.test(req.path) && req.method === 'GET') return true;
  if (/^\/api(?:\/v1)?\/user\/account\/?$/.test(req.path) && req.method === 'DELETE') return true;
  return false;
};

const restrictedResponse = (access: AccountAccess) => {
  const verificationRequired = access.state === 'email_verification_required';
  return {
    message: verificationRequired
      ? 'Verify your email to continue.'
      : 'Accept the current Terms and Privacy Policy to continue.',
    code: verificationRequired ? 'EMAIL_VERIFICATION_REQUIRED' : 'LEGAL_ACCEPTANCE_REQUIRED',
    retryable: false,
    account_access: access
  };
};

/** Restrict incomplete accounts to verification, legal, support, export, deletion, and logout surfaces. */
const isBackendAccountPath = (path: string): boolean =>
  path === '/auth' || path.startsWith('/auth/') || path === '/api' || path.startsWith('/api/');

/** Recheck authenticated account gates for protected routes and reject restricted access without clearing the session. */
export async function enforceAccountAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (
    !isBackendAccountPath(req.path) ||
    !req.isAuthenticated() ||
    !isAuthenticatedUser(req.user) ||
    isRestrictedPathAllowed(req)
  ) {
    next();
    return;
  }

  try {
    const access = await getAccountAccess(req.user.id);
    if (!access) {
      res.status(401).json({ message: 'Not authenticated' });
      return;
    }
    res.locals.accountAccess = access;
    if (access.state === 'full') {
      next();
      return;
    }
    res.status(403).json(restrictedResponse(access));
  } catch (error) {
    logSafeOperationalError('account_access.enforce', error, res.locals?.requestId);
    res.status(500).json({ message: 'Server error' });
  }
}

export { isRestrictedPathAllowed };
