/** @file Opaque native bearer credentials, purpose-specific hashes, and session credential validation. */

import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { MS_PER_DAY, MS_PER_MINUTE } from '../utils/time';
import type { ParsedMobileDevice } from './mobileDevice';
import type { IssuedMobileSession, MobileTokenPair } from './mobileAuthTypes';

const TOKEN_BYTES = 32;
const ACCESS_TOKEN_TTL_MS = 15 * MS_PER_MINUTE; // Short-lived token limits exposure if device storage is compromised.
const REFRESH_TOKEN_TTL_MS = 30 * MS_PER_DAY; // Native clients can stay signed in without storing passwords.

/** Generate an opaque cryptographically random bearer credential; native clients need not retain passwords. */
export const randomMobileToken = (): string =>
  crypto.randomBytes(TOKEN_BYTES).toString('base64url');

/** Derive the server storage/lookup digest without retaining the plaintext bearer token. */
export const hashMobileToken = (token: string): string =>
  crypto.createHash('sha256').update(token, 'utf8').digest('hex');

/** Allocate independent access/refresh credentials with expiries relative to the same issuance time. */
export const buildMobileTokenPair = (now = new Date()): MobileTokenPair => ({
  accessToken: randomMobileToken(),
  refreshToken: randomMobileToken(),
  accessExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
  refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS)
});

/** Create a mobile session and return the one-time visible token pair. */
export async function issueMobileSession(opts: {
  userId: number;
  device: ParsedMobileDevice;
  now?: Date;
}, database: Prisma.TransactionClient | typeof prisma = prisma): Promise<IssuedMobileSession> {
  const tokens = buildMobileTokenPair(opts.now);

  const session = await database.mobileAuthSession.create({
    data: {
      user_id: opts.userId,
      device_id: opts.device.deviceId,
      device_platform: opts.device.devicePlatform,
      device_name: opts.device.deviceName,
      access_token_hash: hashMobileToken(tokens.accessToken),
      refresh_token_hash: hashMobileToken(tokens.refreshToken),
      access_expires_at: tokens.accessExpiresAt,
      refresh_expires_at: tokens.refreshExpiresAt
    }
  });

  return { ...tokens, sessionId: session.id };
}
