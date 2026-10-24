/** @file Strict reusable request parsers for bounded numeric and textual API inputs. */

/**
 * Parse a value into a positive integer (>= 1).
 *
 * Intended for route params like `:id` where we want strict integer semantics.
 * Returns `null` for invalid inputs rather than throwing so callers can map to 400s.
 */
export function parsePositiveInteger(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

/**
 * Parse a value into a non-negative integer (>= 0).
 *
 * This is used for fields like calories where callers may provide numbers or numeric strings.
 * Returns `null` for invalid inputs rather than throwing so callers can map to 400s.
 */
export function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'string' && value.trim().length === 0) {
    return null;
  }

  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const parsed = Math.trunc(numeric);
  if (parsed < 0) {
    return null;
  }

  return parsed;
}

/**
 * Parse a value into a non-negative number (>= 0), allowing decimals.
 *
 * Intended for payloads like servings or calories-per-serving where fractional values are meaningful.
 * Returns `null` for invalid inputs rather than throwing so callers can map to 400s.
 */
export function parseNonNegativeNumber(value: unknown): number | null {
  if (typeof value === 'string' && value.trim().length === 0) {
    return null;
  }

  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }

  return numeric;
}

/**
 * Parse a value into a positive number (> 0), allowing decimals.
 *
 * Intended for values like serving size quantities and servings consumed.
 * Returns `null` for invalid inputs rather than throwing so callers can map to 400s.
 */
export function parsePositiveNumber(value: unknown): number | null {
  if (typeof value === 'string' && value.trim().length === 0) {
    return null;
  }

  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric;
}

/**
 * Resolve a best-effort language code (e.g. "en") from request hints.
 *
 * Preference order:
 * 1) explicit query parameter (e.g. `?lc=en`)
 * 2) Accept-Language header primary tag (e.g. "en-US,en;q=0.9" -> "en")
 */
export function resolveLanguageCode(opts: {
  queryLanguageCode?: unknown;
  acceptLanguageHeader?: unknown;
}): string | undefined {
  const raw = typeof opts.queryLanguageCode === 'string' ? opts.queryLanguageCode.trim().toLowerCase() : undefined;
  if (raw) {
    return raw;
  }

  const header = opts.acceptLanguageHeader;
  if (typeof header !== 'string') {
    return undefined;
  }

  const primary = header.split(',')[0]?.trim();
  if (!primary) {
    return undefined;
  }

  return primary.split('-')[0]?.toLowerCase();
}
