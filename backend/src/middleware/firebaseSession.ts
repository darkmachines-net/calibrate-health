/** @file Reconcile Firebase before honoring existing browser/native sessions; provider outages fail closed without local fallback. */
import type { RequestHandler } from 'express';
import prisma from '../config/database';
import { usesFirebaseAuthentication } from '../config/credentialProvider';
import { firebaseSessionAllowed } from '../services/firebaseAuthority';
import { isAuthenticatedUser } from './authenticatedUser';
import { clearSessionCookie } from '../utils/sessionCookie';

/** Require the persisted session to remain active after provider reconciliation; never revive a revoked browser cookie. */
export const enforceFirebaseSession: RequestHandler = async (req, res, next) => {
  if (!usesFirebaseAuthentication() || !req.isAuthenticated() || !isAuthenticatedUser(req.user)) return next();
  try {
    const allowed = await firebaseSessionAllowed(req.user.id);
    const active = res.locals.mobileAuthSessionId
      ? await prisma.mobileAuthSession.findFirst({ where: { id: res.locals.mobileAuthSessionId, user_id: req.user.id, revoked_at: null }, select: { id: true } })
      : await prisma.sessionStore.findFirst({ where: { sid: req.sessionID, user_id: req.user.id }, select: { sid: true } });
    if (allowed && active) return next();
    Reflect.deleteProperty(req, 'user');
    if (req.session) await new Promise<void>(resolve => req.session.destroy(() => resolve()));
    clearSessionCookie(res);
    res.status(401).json({ message: 'Sign in again to continue.', code: 'SESSION_REVOKED', retryable: false });
  } catch {
    res.status(503).json({ message: 'Sign-in is temporarily unavailable.', code: 'AUTH_UNAVAILABLE', retryable: true });
  }
};
