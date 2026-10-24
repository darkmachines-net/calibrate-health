/** @file Consistent public account-access state for HTTP requests and background operations. */

import type { Prisma } from '@prisma/client';
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION
} from '../../../shared/legalVersions';
import { isHostedServiceDeployment } from '../config/emailDelivery';

type AccountAccessState =
  | 'full'
  | 'email_verification_required'
  | 'legal_acceptance_required';

export type AccountAccess = {
  state: AccountAccessState;
  email_verified: boolean;
  legal_current: boolean;
};

export const ACCOUNT_ACCESS_SELECT = {
  email_verified_at: true,
  legal_acceptances: {
    orderBy: [{ accepted_at: 'desc' as const }, { id: 'desc' as const }],
    select: {
      terms_version: true,
      privacy_version: true,
      accepted_at: true
    }
  }
} satisfies Prisma.UserSelect;

export type AccountAccessSource = Prisma.UserGetPayload<{ select: typeof ACCOUNT_ACCESS_SELECT }>;

/** Reuse the same durable trust boundary for background jobs that bypass request middleware. */
export const CURRENT_ACCOUNT_ACCESS_WHERE = {
  email_verified_at: { not: null },
  ...(isHostedServiceDeployment() ? {
    legal_acceptances: {
      some: {
        terms_version: CURRENT_TERMS_VERSION,
        privacy_version: CURRENT_PRIVACY_VERSION
      }
    }
  } : {})
} satisfies Prisma.UserWhereInput;

/** Derive authorization state from durable verification and versioned consent records. */
export function serializeAccountAccess(
  source: AccountAccessSource | { email_verified_at?: Date | null; legal_acceptances?: AccountAccessSource['legal_acceptances'] }
): AccountAccess {
  const emailVerified = source.email_verified_at === undefined || source.email_verified_at !== null;
  const legalCurrent = !isHostedServiceDeployment() || source.legal_acceptances === undefined || source.legal_acceptances.some((acceptance) =>
    acceptance.terms_version === CURRENT_TERMS_VERSION &&
    acceptance.privacy_version === CURRENT_PRIVACY_VERSION
  );

  let state: AccountAccessState = 'full';
  if (!emailVerified) state = 'email_verification_required';
  else if (!legalCurrent) state = 'legal_acceptance_required';

  return {
    state,
    email_verified: emailVerified,
    legal_current: legalCurrent
  };
}
