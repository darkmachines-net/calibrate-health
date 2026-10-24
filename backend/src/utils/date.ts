/** @file Validated date-only conversion helpers; account timezone derivation remains explicit at callers. */

export const MS_PER_DAY = 24 * 60 * 60 * 1000; // Shared day-duration constant for UTC date-range math.

/** Validate an instant/date input and retain its UTC calendar day; callers must derive account-local dates separately. */
export function normalizeToUtcDateOnly(input: unknown): Date {
  const date =
    input instanceof Date
      ? input
      : typeof input === 'string' || typeof input === 'number'
        ? new Date(input)
        : new Date(NaN);

  if (!Number.isFinite(date.getTime())) {
    throw new Error('Invalid date');
  }

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Add calendar days to a UTC-normalized date without mutating the input.
 *
 * This keeps date math aligned with Postgres DATE semantics and avoids DST skew.
 */
export function addUtcDays(date: Date, deltaDays: number): Date {
  const normalized = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  normalized.setUTCDate(normalized.getUTCDate() + deltaDays);
  return normalized;
}

/**
 * Add calendar years to a UTC-normalized date, clamping leap day to the last
 * valid day of February when the target year is not a leap year.
 */
export function addUtcYearsClamped(date: Date, deltaYears: number): Date {
  const targetYear = date.getUTCFullYear() + deltaYears;
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, month, Math.min(day, lastDayOfTargetMonth)));
}

/** Return today's UTC date-only value for UTC-scoped tasks, not user-local tracking calculations. */
export function getUtcTodayDateOnly(): Date {
  return normalizeToUtcDateOnly(new Date());
}

/**
 * Format a Date into a calendar date string ("YYYY-MM-DD") for the supplied IANA time zone.
 *
 * This is useful for deriving "local day" semantics (e.g. for logging/queries) while storing
 * timestamps in UTC.
 */
export function formatDateToLocalDateString(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    throw new Error('Unable to format local date');
  }

  return `${year}-${month}-${day}`;
}

/**
 * Return a UTC Date at midnight that represents "today" in the supplied IANA time zone.
 *
 * The returned Date is intentionally UTC-normalized so it can be safely stored in Postgres DATE columns.
 */
export function getUtcTodayDateOnlyInTimeZone(timeZone: string, now: Date = new Date()): Date {
  const localDate = formatDateToLocalDateString(now, timeZone);
  return normalizeToUtcDateOnly(localDate);
}

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a date-like input into a UTC-normalized Date suitable for Postgres DATE columns.
 *
 * Accepted inputs:
 * - "YYYY-MM-DD"
 * - any string starting with "YYYY-MM-DD" (e.g. "YYYY-MM-DDT12:00:00Z")
 */
export function parseLocalDateOnly(input: unknown): Date {
  if (typeof input !== 'string') {
    throw new Error('Invalid local date');
  }

  const trimmed = input.trim();
  if (trimmed.length < 10) {
    throw new Error('Invalid local date');
  }

  const datePart = trimmed.slice(0, 10);
  if (!LOCAL_DATE_PATTERN.test(datePart)) {
    throw new Error('Invalid local date');
  }

  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(5, 7));
  const day = Number(datePart.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));

  // JavaScript normalizes impossible dates (for example, 2025-02-31 -> 2025-03-03).
  // Verify the components so invalid user-entered local days cannot drift into another date.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error('Invalid local date');
  }

  return parsed;
}

/**
 * Compute "today" in the supplied IANA time zone as a UTC-normalized DATE value.
 *
 * This is a safe wrapper that falls back to UTC when the user's timezone value is missing/invalid.
 */
export function getSafeUtcTodayDateOnlyInTimeZone(timeZone: unknown, now: Date = new Date()): Date {
  const tz = typeof timeZone === 'string' && timeZone.trim().length > 0 ? timeZone.trim() : 'UTC';

  try {
    return getUtcTodayDateOnlyInTimeZone(tz, now);
  } catch {
    return getUtcTodayDateOnlyInTimeZone('UTC', now);
  }
}

/**
 * Validate an IANA time zone identifier (e.g. "America/Los_Angeles").
 *
 * Node's Intl implementation throws a RangeError when an unknown timeZone is provided,
 * so we can use that as a lightweight runtime validator.
 */
export function isValidIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
