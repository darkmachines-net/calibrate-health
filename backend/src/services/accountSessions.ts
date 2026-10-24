/** @file Account session listing and revocation across browser, phone, and watch credentials. */

import { MobileDevicePlatform, Prisma } from '@prisma/client';
import prisma from '../config/database';

export const ACCOUNT_SESSION_KINDS = {
  BROWSER: 'browser',
  ANDROID_PHONE: 'android_phone',
  IOS: 'ios',
  WEAR_OS: 'wear_os'
} as const;

export type AccountSessionKind =
  (typeof ACCOUNT_SESSION_KINDS)[keyof typeof ACCOUNT_SESSION_KINDS];

export type AccountSessionSummary = {
  id: string;
  kind: AccountSessionKind;
  device_label: string | null;
  created_at: string;
  last_activity_at: string | null;
  current: boolean;
};

export type AccountSessionRevocationResult = {
  revoked: boolean;
  current: boolean;
};

type AccountSessionContext = {
  userId: number;
  currentBrowserSessionId?: string;
  currentMobileSessionId?: number;
  now?: Date;
  db?: typeof prisma;
};

type ParsedAccountSessionId =
  | { kind: 'browser'; publicId: string }
  | { kind: 'mobile'; publicId: string };

const PUBLIC_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DEVICE_LABEL_LENGTH = 100;
const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 2;

const formatAccountSessionId = (kind: 'browser' | 'mobile', publicId: string): string =>
  `${kind}_${publicId}`;

/** Parse the public browser/mobile session identifier without accepting an internal database session key. */
export const parseAccountSessionId = (value: string): ParsedAccountSessionId | null => {
  const match = value.match(/^(browser|mobile)_([0-9a-f-]+)$/i);
  if (!match || !PUBLIC_SESSION_ID_PATTERN.test(match[2])) return null;
  return { kind: match[1].toLowerCase() as 'browser' | 'mobile', publicId: match[2].toLowerCase() };
};

const normalizeDeviceLabel = (value: string | null): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, MAX_DEVICE_LABEL_LENGTH) : null;
};

const mobileKind = (platform: MobileDevicePlatform): AccountSessionKind => {
  switch (platform) {
    case MobileDevicePlatform.IOS:
      return ACCOUNT_SESSION_KINDS.IOS;
    case MobileDevicePlatform.WEAR_OS:
      return ACCOUNT_SESSION_KINDS.WEAR_OS;
    default:
      return ACCOUNT_SESSION_KINDS.ANDROID_PHONE;
  }
};

const activityTimestamp = (session: AccountSessionSummary): number =>
  Date.parse(session.last_activity_at ?? session.created_at);

const isRetryableTransactionConflict = (error: unknown): boolean => {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = String(error.code);
  return code === 'P2034' || code === '40001' || code === '40P01';
};

const runSerializable = async <T>(db: typeof prisma, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
  for (let attempt = 1; attempt <= SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    } catch (error) {
      if (attempt === SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS || !isRetryableTransactionConflict(error)) throw error;
    }
  }
  throw new Error('Session revocation transaction did not complete.');
};

/** List active browser, phone, and watch sessions without exposing credential or device identifiers. */
export const listAccountSessionsForUser = async ({
  userId,
  currentBrowserSessionId,
  currentMobileSessionId,
  now = new Date(),
  db = prisma
}: AccountSessionContext): Promise<AccountSessionSummary[]> => {
  const [browserSessions, mobileSessions] = await Promise.all([
    db.sessionStore.findMany({
      where: { user_id: userId, expire: { gt: now } },
      orderBy: [{ last_used_at: 'desc' }, { created_at: 'desc' }],
      select: {
        sid: true,
        public_id: true,
        created_at: true,
        last_used_at: true
      }
    }),
    db.mobileAuthSession.findMany({
      where: {
        user_id: userId,
        revoked_at: null,
        refresh_expires_at: { gt: now }
      },
      orderBy: [{ last_used_at: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        public_id: true,
        device_platform: true,
        device_name: true,
        created_at: true,
        last_used_at: true
      }
    })
  ]);

  const sessions: AccountSessionSummary[] = [
    ...browserSessions.map((session) => ({
      id: formatAccountSessionId('browser', session.public_id),
      kind: ACCOUNT_SESSION_KINDS.BROWSER,
      device_label: null,
      created_at: session.created_at.toISOString(),
      last_activity_at: session.last_used_at.toISOString(),
      current: session.sid === currentBrowserSessionId
    })),
    ...mobileSessions.map((session) => ({
      id: formatAccountSessionId('mobile', session.public_id),
      kind: mobileKind(session.device_platform),
      device_label: normalizeDeviceLabel(session.device_name),
      created_at: session.created_at.toISOString(),
      last_activity_at: session.last_used_at?.toISOString() ?? null,
      current: session.id === currentMobileSessionId
    }))
  ];

  return sessions.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    return activityTimestamp(right) - activityTimestamp(left) || right.id.localeCompare(left.id);
  });
};

/** Revoke one remote session only when the public id belongs to the authenticated account. */
export const revokeAccountSessionForUser = async ({
  userId,
  sessionId,
  currentBrowserSessionId,
  currentMobileSessionId,
  db = prisma
}: Omit<AccountSessionContext, 'now'> & { sessionId: string }): Promise<AccountSessionRevocationResult> => {
  const parsed = parseAccountSessionId(sessionId);
  if (!parsed) return { revoked: false, current: false };

  if (parsed.kind === 'browser') {
    const session = await db.sessionStore.findFirst({
      where: { user_id: userId, public_id: parsed.publicId },
      select: { sid: true }
    });
    if (!session) return { revoked: false, current: false };
    if (session.sid === currentBrowserSessionId) return { revoked: false, current: true };
    const result = await db.sessionStore.deleteMany({
      where: { user_id: userId, public_id: parsed.publicId }
    });
    return { revoked: result.count === 1, current: false };
  }

  const session = await db.mobileAuthSession.findFirst({
    where: { user_id: userId, public_id: parsed.publicId, revoked_at: null },
    select: { id: true }
  });
  if (!session) return { revoked: false, current: false };
  if (session.id === currentMobileSessionId) return { revoked: false, current: true };

  const revoked = await runSerializable(db, async (tx) => {
    const result = await tx.mobileAuthSession.updateMany({
      where: { id: session.id, user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() }
    });
    if (result.count > 0) {
      await tx.nativePushSubscription.updateMany({
        where: { user_id: userId, mobile_auth_session_id: session.id, revoked_at: null },
        data: { revoked_at: new Date() }
      });
    }
    return result.count === 1;
  });
  return { revoked, current: false };
};

/** Revoke all browser/native sessions except the caller's one current session in one serializable transaction. */
export const revokeOtherAccountSessionsForUser = async ({
  userId,
  currentBrowserSessionId,
  currentMobileSessionId,
  db = prisma
}: Omit<AccountSessionContext, 'now'>): Promise<number> => runSerializable(db, async (tx) => {
  const mobileSessions = await tx.mobileAuthSession.findMany({
    where: {
      user_id: userId,
      revoked_at: null,
      ...(currentMobileSessionId ? { id: { not: currentMobileSessionId } } : {})
    },
    select: { id: true }
  });
  const mobileSessionIds = mobileSessions.map((session) => session.id);

  const browserResult = await tx.sessionStore.deleteMany({
    where: {
      user_id: userId,
      ...(currentBrowserSessionId ? { sid: { not: currentBrowserSessionId } } : {})
    }
  });
  const mobileResult = mobileSessionIds.length > 0
    ? await tx.mobileAuthSession.updateMany({
        where: { user_id: userId, id: { in: mobileSessionIds }, revoked_at: null },
        data: { revoked_at: new Date() }
      })
    : { count: 0 };

  if (mobileSessionIds.length > 0) {
    await tx.nativePushSubscription.updateMany({
      where: { user_id: userId, mobile_auth_session_id: { in: mobileSessionIds }, revoked_at: null },
      data: { revoked_at: new Date() }
    });
  }

  return browserResult.count + mobileResult.count;
});
