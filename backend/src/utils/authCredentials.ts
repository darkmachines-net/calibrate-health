/** @file Credential normalization and password handling at backend authentication boundaries. */

import {
  MAX_AUTH_PASSWORD_BYTES,
  MIN_AUTH_PASSWORD_LENGTH,
  normalizeAuthEmailCredential,
  utf8ByteLength
} from '../../../shared/authCredentials';

export { MAX_AUTH_PASSWORD_BYTES };
// Comparing against a fixed valid hash keeps unknown-account login timing close to wrong-password timing.
export const DUMMY_AUTH_PASSWORD_HASH = '$2b$10$24sOV1l/uVCwMwPmB4.2X.K6q10fTODGqeX7xEILbzcoM0zIgAwFC';

/**
 * Normalize an email credential for lookup/storage.
 *
 * The validator is intentionally lightweight: it catches malformed credentials before
 * hitting Prisma while still leaving detailed deliverability rules to email providers.
 */
export function normalizeEmailCredential(value: unknown): string | null {
  return normalizeAuthEmailCredential(value);
}

/** Reject values bcrypt would silently truncate after UTF-8 encoding. */
export function validateBcryptPasswordByteLength(value: string, label = 'Password'): string | null {
  return utf8ByteLength(value) > MAX_AUTH_PASSWORD_BYTES
    ? `${label} must be at most ${MAX_AUTH_PASSWORD_BYTES} bytes`
    : null;
}

/**
 * Validate password credential shape and bcrypt-safe UTF-8 byte length.
 */
export function validatePasswordCredential(value: unknown, label = 'Password'): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return `${label} is required`;
  }

  if (value.length < MIN_AUTH_PASSWORD_LENGTH) {
    return `${label} must be at least ${MIN_AUTH_PASSWORD_LENGTH} characters`;
  }

  const byteLengthError = validateBcryptPasswordByteLength(value, label);
  if (byteLengthError) return byteLengthError;

  return null;
}
