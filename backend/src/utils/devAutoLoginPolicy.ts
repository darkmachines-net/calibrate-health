/** @file dev Auto Login Policy: Decide whether the current request should auto-login the local test user. */

import type { Request } from 'express';

import { isProductionOrStagingEnv } from '../config/environment';

export type AutoLoginRequestLike = Pick<Request, 'path' | 'isAuthenticated'>;

/**
 * Decide whether the current request should auto-login the local test user.
 *
 * We keep this logic separate from the Prisma-dependent middleware so it can be unit tested
 * without requiring DATABASE_URL.
 */
export function shouldAutoLoginTestUser(
  req: AutoLoginRequestLike,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const enabled = env.AUTO_LOGIN_TEST_USER === 'true';
  const isProductionOrStaging = isProductionOrStagingEnv(env.NODE_ENV);
  const isLoggingOut = req.path.startsWith('/auth/logout');
  return enabled && !isProductionOrStaging && !isLoggingOut && !req.isAuthenticated();
}
