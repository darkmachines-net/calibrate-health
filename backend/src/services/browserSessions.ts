/** @file Persisted browser-session revocation, including push-subscription cleanup and current-session preservation. */

import prisma from '../config/database';

/**
 * Revoke every persisted browser session for an account except the request session.
 * Deleting SessionStore rows also removes browser push subscriptions by foreign key.
 */
export async function revokeOtherBrowserSessionsForUser(
  userId: number,
  currentSessionId?: string
): Promise<number> {
  const result = await prisma.sessionStore.deleteMany({
    where: {
      user_id: userId,
      ...(currentSessionId ? { sid: { not: currentSessionId } } : {})
    }
  });
  return result.count;
}
