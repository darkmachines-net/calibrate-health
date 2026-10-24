/** @file Durable account access gates, required legal acceptance, and serialization of restricted-account states. */

import prisma from '../config/database';
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION
} from '../../../shared/legalVersions';
import {
  ACCOUNT_ACCESS_SELECT,
  serializeAccountAccess,
  type AccountAccess,
  type AccountAccessSource
} from '../utils/accountAccessSerialization';

export {
  ACCOUNT_ACCESS_SELECT,
  serializeAccountAccess,
  type AccountAccess,
  type AccountAccessSource
} from '../utils/accountAccessSerialization';

export type LegalStatusPayload = {
  account_access: AccountAccess;
  required: {
    terms_version: string;
    privacy_version: string;
  };
  accepted: {
    terms_version: string | null;
    privacy_version: string | null;
    accepted_at: string | null;
  };
};

/** Return required and genuinely accepted legal versions, preserving missing acceptance as null. */
export function serializeLegalStatus(source: AccountAccessSource): LegalStatusPayload {
  const latestAcceptance = source.legal_acceptances[0] ?? null;
  return {
    account_access: serializeAccountAccess(source),
    required: {
      terms_version: CURRENT_TERMS_VERSION,
      privacy_version: CURRENT_PRIVACY_VERSION
    },
    accepted: {
      terms_version: latestAcceptance?.terms_version ?? null,
      privacy_version: latestAcceptance?.privacy_version ?? null,
      accepted_at: latestAcceptance?.accepted_at.toISOString() ?? null
    }
  };
}

/** Read current verification/legal gates for an account, returning null when that account no longer exists. */
export async function getAccountAccess(userId: number): Promise<AccountAccess | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: ACCOUNT_ACCESS_SELECT
  });
  return user ? serializeAccountAccess(user) : null;
}

/** Read current legal requirements and acceptance history without synthesizing consent for an existing account. */
export async function getLegalStatus(userId: number): Promise<LegalStatusPayload | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: ACCOUNT_ACCESS_SELECT
  });
  return user ? serializeLegalStatus(user) : null;
}

/** Record genuine acceptance of exactly the currently published legal documents. */
export async function acceptCurrentLegalDocuments(userId: number): Promise<LegalStatusPayload | null> {
  await prisma.legalAcceptance.upsert({
    where: {
      user_id_terms_version_privacy_version: {
        user_id: userId,
        terms_version: CURRENT_TERMS_VERSION,
        privacy_version: CURRENT_PRIVACY_VERSION
      }
    },
    create: {
      user_id: userId,
      terms_version: CURRENT_TERMS_VERSION,
      privacy_version: CURRENT_PRIVACY_VERSION
    },
    update: {}
  });
  return getLegalStatus(userId);
}
