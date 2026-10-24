/** @file dev Auth: Attach the test user to the session for local development convenience. */

import type { NextFunction, Request, Response } from 'express';
import prisma from '../config/database';
import { ensureDevTestData } from '../services/devTestData';
import { shouldAutoLoginTestUser } from './devAutoLoginPolicy';

/**
 * Dev-only auto-login middleware for the deterministic test user.
 */
const TEST_USER_EMAIL = 'test@calibratehealth.app';

/**
 * Attach the test user to the session for local development convenience.
 */
export const autoLoginTestUser = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  if (!shouldAutoLoginTestUser(req)) {
    next();
    return;
  }

  try {
    // Make auto-login robust: if the dev DB is fresh, ensure the deterministic
    // user + baseline data exist before attempting to log in.
    await ensureDevTestData();
  } catch (error) {
    console.warn('Dev auto-login: unable to ensure seed data:', error);
  }

  const user = await prisma.user.findUnique({
    where: { email: TEST_USER_EMAIL },
    // Keep the one-request auto-login payload aligned with the normal deserialized session user.
    select: {
      id: true,
      email: true,
      weight_unit: true,
      height_unit: true,
      timezone: true,
      date_of_birth: true,
      sex: true,
      height_mm: true,
      activity_level: true,
    },
  });
  if (!user) {
    next();
    return;
  }

  req.login(user, (err) => {
    if (err) {
      next(err);
      return;
    }
    next();
  });
};
