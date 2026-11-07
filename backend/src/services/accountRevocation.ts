/** @file Revoke all Calibrate credential families in the caller's account-security transaction. */
import type { Prisma } from '@prisma/client';

/** Invalidate browser, native, Wear, recovery and MCP credentials together; caller owns the transaction. */
export async function revokeAccountCredentials(tx: Prisma.TransactionClient, userId: number, now = new Date()): Promise<void> {
  await tx.sessionStore.deleteMany({ where: { user_id: userId } });
  await tx.pushSubscription.deleteMany({ where: { user_id: userId } });
  await tx.mobileAuthSession.updateMany({ where: { user_id: userId, revoked_at: null }, data: { revoked_at: now } });
  await tx.nativePushSubscription.updateMany({ where: { user_id: userId, revoked_at: null }, data: { revoked_at: now } });
  await tx.wearPairingCredential.updateMany({ where: { user_id: userId, consumed_at: null }, data: { consumed_at: now } });
  await tx.mcpOAuthGrant.updateMany({ where: { user_id: userId, revoked_at: null }, data: { revoked_at: now } });
  await tx.mcpOAuthAuthorizationCode.deleteMany({ where: { user_id: userId } });
  await tx.accountActionToken.deleteMany({ where: { user_id: userId } });
}
