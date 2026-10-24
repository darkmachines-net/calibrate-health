/** @file Gated development test controls for deterministic application scenarios. */

import express from 'express';
import { isProductionOrStagingEnv } from '../config/environment';
import prisma from '../config/database';
import { resetDevTestUserToPreOnboardingState } from '../services/devTestData';
import { serializeUserForClient, USER_CLIENT_SELECT } from '../utils/userSerialization';

/**
 * Dev-only test utilities (resetting deterministic accounts, etc.).
 */
const router = express.Router();

/**
 * Guard dev routes even if they are accidentally mounted in production/staging.
 */
const requireNonProduction = (
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  if (isProductionOrStagingEnv(process.env.NODE_ENV)) {
    res.status(404).json({ message: 'Not found' });
    return;
  }
  next();
};

/**
 * Reset the deterministic dev test account to a pre-onboarding state.
 *
 * This keeps the session intact (same user id), but clears profile/goal/metrics data so the app
 * routes users back through onboarding without requiring a separate account.
 */
router.use(requireNonProduction);

/**
 * Reset the deterministic dev test account to a pre-onboarding state.
 *
 * This keeps the session intact (same user id), but clears profile/goal/metrics data so the app
 * routes users back through onboarding without requiring a separate account.
 */
router.post('/reset-test-user-onboarding', async (_req, res) => {
  try {
    const userId = await resetDevTestUserToPreOnboardingState();

    const updatedUser = await prisma.user.findUnique({
      where: { id: userId },
      select: USER_CLIENT_SELECT
    });

    /**
 * Reset the deterministic dev test account to a pre-onboarding state.
 *
 * This keeps the session intact (same user id), but clears profile/goal/metrics data so the app
 * routes users back through onboarding without requiring a separate account.
 */
    res.json({
      ok: true,
      user: updatedUser ? serializeUserForClient(updatedUser) : null
    });
  } catch (error) {
    /**
 * Reset the deterministic dev test account to a pre-onboarding state.
 *
 * This keeps the session intact (same user id), but clears profile/goal/metrics data so the app
 * routes users back through onboarding without requiring a separate account.
 */
    console.error('Dev test route: unable to reset test user onboarding state:', error);
    /**
 * Reset the deterministic dev test account to a pre-onboarding state.
 *
 * This keeps the session intact (same user id), but clears profile/goal/metrics data so the app
 * routes users back through onboarding without requiring a separate account.
 */
    res.status(500).json({ message: 'Failed to reset test user' });
  }
});

export default router;
