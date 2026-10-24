/** @file Native session issuance, rotation, revocation, and public authenticated-account responses. */

import { MobileDevicePlatform } from '@prisma/client';
import prisma from '../config/database';
import {
  serializeUserForClient,
  USER_CLIENT_SELECT
} from '../utils/userSerialization';
import {
  serializeMobileDevicePlatform,
  type ParsedMobileDevice
} from './mobileDevice';
import {
  buildMobileTokenPair,
  hashMobileToken,
  issueMobileSession
} from './mobileSessionCredentials';
import { serializeWearAuthPrincipal } from './wearPairing';
import type {
  AuthenticateAccessTokenResult,
  MobileAuthSessionPayload,
  MobileSessionSummary
} from './mobileAuthTypes';

export {
  parseMobileDevicePayload,
  serializeMobileDevicePlatform
} from './mobileDevice';
export {
  hashMobileToken,
  issueMobileSession
} from './mobileSessionCredentials';
export {
  buildWearPairingChallengePayload,
  exchangeWearPairingCredential,
  issueWearPairingCredential,
  normalizePairingServerOrigin,
  parseWearPublicKeySpki,
  WEAR_PAIRING_PROTOCOL_VERSION
} from './wearPairing';
export type {
  MobileAuthSessionPayload,
  MobileSessionSummary,
  WearAuthPrincipal,
  WearPairingCredentialPayload,
  WearPairingErrorCode,
  WearPairingExchangeResult,
  WearPairingIssueResult
} from './mobileAuthTypes';

/** Issue device credentials and combine them with the current serialized user, omitting internal session IDs. */
export async function issueMobileAuthPayload(opts: {
  userId: number;
  device: ParsedMobileDevice;
}): Promise<MobileAuthSessionPayload | null> {
  const [user, issuedSession] = await Promise.all([
    prisma.user.findUnique({ where: { id: opts.userId }, select: USER_CLIENT_SELECT }),
    issueMobileSession(opts)
  ]);

  if (!user) {
    return null;
  }

  const { sessionId: _sessionId, ...tokens } = issuedSession;

  return {
    user: serializeUserForClient(user),
    ...tokens
  };
}

/** Issue only while the credential snapshot verified by local login is still current. */
export async function issueVerifiedMobileAuthPayload(opts: {
  userId: number;
  credentialSecurityVersion: number;
  device: ParsedMobileDevice;
}): Promise<MobileAuthSessionPayload | null> {
  if (!Number.isSafeInteger(opts.credentialSecurityVersion) || opts.credentialSecurityVersion < 0) return null;
  return prisma.$transaction(async (tx) => {
    // This row lock orders issuance against password writers and account deletion.
    const current = await tx.user.updateMany({
      where: { id: opts.userId, credential_security_version: opts.credentialSecurityVersion },
      data: { credential_security_version: opts.credentialSecurityVersion }
    });
    if (current.count !== 1) return null;
    const user = await tx.user.findUnique({ where: { id: opts.userId }, select: USER_CLIENT_SELECT });
    if (!user) return null;
    // Restricted accounts keep their recovery session; serialization retains current access gates.
    const { sessionId: _sessionId, ...tokens } = await issueMobileSession(opts, tx);
    return { user: serializeUserForClient(user), ...tokens };
  });
}

/** Rotate a refresh token into a new access/refresh pair for the same native session. */
export async function refreshMobileSession(refreshToken: string): Promise<MobileAuthSessionPayload | null> {
  const tokenHash = hashMobileToken(refreshToken);
  const now = new Date();
  const existing = await prisma.mobileAuthSession.findUnique({
    where: { refresh_token_hash: tokenHash },
    select: { id: true }
  });

  if (!existing) return null;

  const tokens = buildMobileTokenPair(now);
  // Claim the presented refresh token in one database write. Concurrent replays can read the
  // same session, but only one can replace the matching hash and create a valid successor chain.
  const claimed = await prisma.mobileAuthSession.updateMany({
    where: {
      id: existing.id,
      refresh_token_hash: tokenHash,
      revoked_at: null,
      refresh_expires_at: { gt: now }
    },
    data: {
      access_token_hash: hashMobileToken(tokens.accessToken),
      refresh_token_hash: hashMobileToken(tokens.refreshToken),
      access_expires_at: tokens.accessExpiresAt,
      refresh_expires_at: tokens.refreshExpiresAt,
      last_used_at: now
    }
  });

  if (claimed.count !== 1) return null;

  const updated = await prisma.mobileAuthSession.findUnique({
    where: { id: existing.id },
    include: {
      user: {
        select: USER_CLIENT_SELECT
      }
    }
  });

  if (!updated) return null;

  const user = updated.device_platform === MobileDevicePlatform.WEAR_OS
    ? serializeWearAuthPrincipal(updated.user)
    : serializeUserForClient(updated.user);

  return {
    user,
    ...tokens
  };
}

/** Revoke a mobile session by refresh token. Repeated logout calls remain idempotent. */
export async function revokeMobileSessionByRefreshToken(refreshToken: string): Promise<void> {
  const tokenHash = hashMobileToken(refreshToken);
  await revokeMobileSessionsAndPushSubscriptions({ refresh_token_hash: tokenHash });
}

/** Revoke sessions and every push endpoint authorized by them in the same database transaction. */
async function revokeMobileSessionsAndPushSubscriptions(tokenWhere: {
  access_token_hash?: string;
  refresh_token_hash?: string;
}): Promise<void> {
  const sessions = await prisma.mobileAuthSession.findMany({
    where: {
      ...tokenWhere,
      revoked_at: null
    },
    select: { id: true }
  });
  await revokeMobileSessionIds(sessions.map((session) => session.id));
}

/** Revoke a known set of owned sessions and their notification endpoints atomically. */
async function revokeMobileSessionIds(sessionIds: number[]): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const revokedAt = new Date();
  const [sessionResult] = await prisma.$transaction([
    prisma.mobileAuthSession.updateMany({
      where: { id: { in: sessionIds }, revoked_at: null },
      data: { revoked_at: revokedAt }
    }),
    prisma.nativePushSubscription.updateMany({
      where: { mobile_auth_session_id: { in: sessionIds }, revoked_at: null },
      data: { revoked_at: revokedAt }
    })
  ]);
  return sessionResult.count;
}

/** Revoke a mobile session by access token when the refresh token is not available. */
export async function revokeMobileSessionByAccessToken(accessToken: string): Promise<void> {
  const tokenHash = hashMobileToken(accessToken);
  await revokeMobileSessionsAndPushSubscriptions({ access_token_hash: tokenHash });
}

/** List active native sessions without exposing credential hashes. */
export async function listMobileSessionsForUser(
  userId: number,
  currentSessionId?: number
): Promise<MobileSessionSummary[]> {
  const sessions = await prisma.mobileAuthSession.findMany({
    where: {
      user_id: userId,
      revoked_at: null,
      refresh_expires_at: { gt: new Date() }
    },
    orderBy: [{ last_used_at: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      device_id: true,
      device_platform: true,
      device_name: true,
      created_at: true,
      last_used_at: true,
      refresh_expires_at: true
    }
  });

  return sessions.map((session) => ({
    id: session.id,
    device_id: session.device_id,
    device_platform: serializeMobileDevicePlatform(session.device_platform),
    device_name: session.device_name,
    created_at: session.created_at.toISOString(),
    last_used_at: session.last_used_at?.toISOString() ?? null,
    refresh_expires_at: session.refresh_expires_at.toISOString(),
    current: session.id === currentSessionId
  }));
}

/** Revoke one session only when it belongs to the authenticated account. */
export async function revokeMobileSessionForUser(userId: number, sessionId: number): Promise<boolean> {
  const owned = await prisma.mobileAuthSession.findFirst({
    where: { id: sessionId, user_id: userId, revoked_at: null },
    select: { id: true }
  });
  if (!owned) return false;
  return (await revokeMobileSessionIds([owned.id])) === 1;
}

/** Revoke every active native session except the caller's current bearer session, when present. */
export async function revokeOtherMobileSessionsForUser(
  userId: number,
  currentSessionId?: number
): Promise<number> {
  const sessions = await prisma.mobileAuthSession.findMany({
    where: {
      user_id: userId,
      revoked_at: null,
      ...(currentSessionId ? { id: { not: currentSessionId } } : {})
    },
    select: { id: true }
  });
  return revokeMobileSessionIds(sessions.map((session) => session.id));
}

/** Resolve and validate the Authorization header used by native clients. */
export async function authenticateMobileAccessToken(
  authorizationHeader: string
): Promise<AuthenticateAccessTokenResult> {
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { ok: false, status: 401, message: 'Invalid authorization header' };
  }

  const token = match[1]?.trim();
  if (!token) {
    return { ok: false, status: 401, message: 'Invalid authorization header' };
  }

  const now = new Date();
  const session = await prisma.mobileAuthSession.findUnique({
    where: { access_token_hash: hashMobileToken(token) },
    include: {
      user: {
        select: USER_CLIENT_SELECT
      }
    }
  });

  if (!session || session.revoked_at || session.access_expires_at <= now) {
    return { ok: false, status: 401, message: 'Invalid or expired access token' };
  }

  await prisma.mobileAuthSession.update({
    where: { id: session.id },
    data: { last_used_at: now }
  });

  return {
    ok: true,
    user: session.device_platform === MobileDevicePlatform.WEAR_OS
      ? serializeWearAuthPrincipal(session.user)
      : serializeUserForClient(session.user),
    sessionId: session.id,
    deviceId: session.device_id,
    devicePlatform: serializeMobileDevicePlatform(session.device_platform)
  };
}

/** Convert native credentials and expiry timestamps to the stable snake-case auth response. */
export function formatMobileAuthResponse(payload: MobileAuthSessionPayload) {
  return {
    user: payload.user,
    access_token: payload.accessToken,
    refresh_token: payload.refreshToken,
    access_expires_at: payload.accessExpiresAt.toISOString(),
    refresh_expires_at: payload.refreshExpiresAt.toISOString()
  };
}
