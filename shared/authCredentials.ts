/** @file Canonical email/password syntax and bounds shared by client validation and server authentication. */

export const MIN_AUTH_PASSWORD_LENGTH = 8;
// bcrypt only uses the first 72 UTF-8 bytes of a password; cap input so users do not create misleading secrets.
export const MAX_AUTH_PASSWORD_BYTES = 72;
const MAX_AUTH_EMAIL_LENGTH = 254;

const BASIC_AUTH_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim/lowercase a bounded syntactically valid email credential, returning null for invalid input. */
export function normalizeAuthEmailCredential(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > MAX_AUTH_EMAIL_LENGTH) return null;
  if (!BASIC_AUTH_EMAIL_PATTERN.test(normalized)) return null;

  return normalized;
}

/** Count encoded bytes by Unicode code point so password limits apply consistently across runtimes. */
export function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) length += 1;
    else if (codePoint <= 0x7ff) length += 2;
    else if (codePoint <= 0xffff) length += 3;
    else length += 4;
  }
  return length;
}
