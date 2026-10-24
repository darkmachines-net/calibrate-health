/** @file Purpose-bound verification and recovery token hashing, expiry, issuance, and consumption. */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { AccountTokenPurpose, type Prisma } from '@prisma/client';
import prisma from '../config/database';
import { MS_PER_DAY, MS_PER_MINUTE } from '../utils/time';
import { deliverAccountEmail } from './accountEmail';
import { getAccountAccess, type AccountAccess } from './accountAccess';

const TOKEN_BYTES = 32;
export const EMAIL_VERIFICATION_TTL_MS = MS_PER_DAY;
export const PASSWORD_RESET_TTL_MS = 30 * MS_PER_MINUTE;

const randomAccountToken = (): string => crypto.randomBytes(TOKEN_BYTES).toString('base64url');

/** Bind hashes to purpose so a token can never cross verification/recovery contexts. */
export const hashAccountToken = (purpose: AccountTokenPurpose, token: string): string =>
  crypto.createHash('sha256').update(`${purpose}:${token}`, 'utf8').digest('hex');

const tokenTtl = (purpose: AccountTokenPurpose): number =>
  purpose === AccountTokenPurpose.EMAIL_VERIFICATION
    ? EMAIL_VERIFICATION_TTL_MS
    : PASSWORD_RESET_TTL_MS;

/** Invalidate earlier unused tokens for this purpose and store only the new token hash and expiry. */
export async function issueAccountActionToken(
  userId: number,
  purpose: AccountTokenPurpose,
  now = new Date(),
  database: Prisma.TransactionClient | typeof prisma = prisma
): Promise<string> {
  const token = randomAccountToken();
  await database.accountActionToken.updateMany({
    where: { user_id: userId, purpose, consumed_at: null },
    data: { consumed_at: now }
  });
  await database.accountActionToken.create({
    data: {
      user_id: userId,
      purpose,
      token_hash: hashAccountToken(purpose, token),
      expires_at: new Date(now.getTime() + tokenTtl(purpose))
    }
  });
  return token;
}

async function invalidateIssuedToken(
  purpose: AccountTokenPurpose,
  token: string,
  now = new Date()
): Promise<void> {
  await prisma.accountActionToken.updateMany({
    where: { purpose, token_hash: hashAccountToken(purpose, token), consumed_at: null },
    data: { consumed_at: now }
  });
}

/** Create and deliver a verification link, invalidating the credential if delivery fails. */
export async function sendEmailVerification(userId: number): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, email_verified_at: true }
  });
  if (!user || user.email_verified_at) return true;

  const token = await issueAccountActionToken(userId, AccountTokenPurpose.EMAIL_VERIFICATION);
  const delivered = await deliverAccountEmail({
    kind: 'email_verification',
    recipient: user.email,
    token
  });
  if (!delivered) await invalidateIssuedToken(AccountTokenPurpose.EMAIL_VERIFICATION, token);
  return delivered;
}

/** Create a recovery link only for known accounts; callers always return a generic response. */
export async function sendPasswordReset(userId: number, email: string): Promise<boolean> {
  const token = await issueAccountActionToken(userId, AccountTokenPurpose.PASSWORD_RESET);
  const delivered = await deliverAccountEmail({
    kind: 'password_reset',
    recipient: email,
    token
  });
  if (!delivered) await invalidateIssuedToken(AccountTokenPurpose.PASSWORD_RESET, token);
  return delivered;
}

class TokenClaimFailed extends Error {}

/** Consume an unexpired verification token transactionally and return refreshed access, or null for invalid credentials. */
export async function confirmEmailVerification(
  token: string,
  now = new Date()
): Promise<AccountAccess | null> {
  const tokenHash = hashAccountToken(AccountTokenPurpose.EMAIL_VERIFICATION, token);
  try {
    const userId = await prisma.$transaction(async (transaction) => {
      const credential = await transaction.accountActionToken.findUnique({
        where: { token_hash: tokenHash },
        select: { id: true, user_id: true, purpose: true, expires_at: true, consumed_at: true }
      });
      if (
        !credential ||
        credential.purpose !== AccountTokenPurpose.EMAIL_VERIFICATION ||
        credential.consumed_at ||
        credential.expires_at <= now
      ) throw new TokenClaimFailed();

      const claimed = await transaction.accountActionToken.updateMany({
        where: {
          id: credential.id,
          purpose: AccountTokenPurpose.EMAIL_VERIFICATION,
          consumed_at: null,
          expires_at: { gt: now }
        },
        data: { consumed_at: now }
      });
      if (claimed.count !== 1) throw new TokenClaimFailed();

      await transaction.user.update({
        where: { id: credential.user_id },
        data: { email_verified_at: now }
      });
      return credential.user_id;
    });
    return getAccountAccess(userId);
  } catch (error) {
    if (error instanceof TokenClaimFailed) return null;
    throw error;
  }
}

/** Consume a valid reset token, replace the password and revoke account sessions/grants in one transaction. */
export async function resetPasswordWithToken(
  token: string,
  newPassword: string,
  now = new Date()
): Promise<boolean> {
  const tokenHash = hashAccountToken(AccountTokenPurpose.PASSWORD_RESET, token);
  const passwordHash = await bcrypt.hash(newPassword, 10);
  try {
    await prisma.$transaction(async (transaction) => {
      const credential = await transaction.accountActionToken.findUnique({
        where: { token_hash: tokenHash },
        select: { id: true, user_id: true, purpose: true, expires_at: true, consumed_at: true }
      });
      if (
        !credential ||
        credential.purpose !== AccountTokenPurpose.PASSWORD_RESET ||
        credential.consumed_at ||
        credential.expires_at <= now
      ) throw new TokenClaimFailed();

      const claimed = await transaction.accountActionToken.updateMany({
        where: {
          id: credential.id,
          purpose: AccountTokenPurpose.PASSWORD_RESET,
          consumed_at: null,
          expires_at: { gt: now }
        },
        data: { consumed_at: now }
      });
      if (claimed.count !== 1) throw new TokenClaimFailed();

      await transaction.user.update({
        where: { id: credential.user_id },
        data: { password_hash: passwordHash }
      });
      await transaction.accountActionToken.updateMany({
        where: {
          user_id: credential.user_id,
          purpose: AccountTokenPurpose.PASSWORD_RESET,
          consumed_at: null
        },
        data: { consumed_at: now }
      });
      await transaction.pushSubscription.deleteMany({ where: { user_id: credential.user_id } });
      await transaction.sessionStore.deleteMany({ where: { user_id: credential.user_id } });
      await transaction.mobileAuthSession.updateMany({
        where: { user_id: credential.user_id, revoked_at: null },
        data: { revoked_at: now }
      });
      await transaction.mcpOAuthGrant.updateMany({
        where: { user_id: credential.user_id, revoked_at: null },
        data: { revoked_at: now }
      });
      await transaction.mcpOAuthAuthorizationCode.deleteMany({
        where: { user_id: credential.user_id }
      });
      // A credential issued before reset must not be able to mint a replacement Wear session.
      await transaction.wearPairingCredential.updateMany({
        where: { user_id: credential.user_id, consumed_at: null },
        data: { consumed_at: now }
      });
      await transaction.nativePushSubscription.updateMany({
        where: { user_id: credential.user_id, revoked_at: null },
        data: { revoked_at: now }
      });
    });
    return true;
  } catch (error) {
    if (error instanceof TokenClaimFailed) return false;
    throw error;
  }
}
