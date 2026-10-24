/** @file authenticated User: Small, non-sensitive principal shared by browser, phone, and Wear requests. */

import type { HeightUnit, WeightUnit } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

/**
 * Small, non-sensitive principal shared by browser, phone, and Wear requests.
 *
 * Authentication hydrates profile fields for current clients, but authorization
 * depends only on the stable account id. Routes must validate or default optional
 * profile fields at their domain boundary.
 */
export type AuthenticatedUser = {
  id: number;
  timezone?: string;
  weight_unit?: WeightUnit;
  height_unit?: HeightUnit;
};

/** Narrow an unknown principal only when it carries a positive safe integer account ID. */
export const isAuthenticatedUser = (
  value: unknown
): value is AuthenticatedUser => {
  if (!value || typeof value !== 'object') return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
};

/** Apply the API's consistent authentication response and reject invalid account identities. */
export const requireAuthenticatedUser = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (req.isAuthenticated() && isAuthenticatedUser(req.user)) {
    return next();
  }
  return res.status(401).json({ message: 'Not authenticated' });
};

/**
 * Return the principal established by requireAuthenticatedUser or an equivalent
 * endpoint-specific guard. Keeping this assertion here removes unsafe route casts.
 */
export const getAuthenticatedUser = (req: Request): AuthenticatedUser => {
  if (!isAuthenticatedUser(req.user)) {
    throw new Error('Authenticated request is missing a valid user principal');
  }
  return req.user;
};
