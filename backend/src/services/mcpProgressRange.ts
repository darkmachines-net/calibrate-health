/** @file Strict account-local historical bounds shared by MCP overview, comparison, and detail readers. */

import type { ProgressRange, ProgressRangeInput } from '../mcp/progressTypes';
import { addUtcDays, getSafeUtcTodayDateOnlyInTimeZone, MS_PER_DAY, parseLocalDateOnly } from '../utils/date';

const MCP_MAX_PROGRESS_DAYS = 365;
const DEFAULT_PROGRESS_DAYS = 90;

/** Caller-correctable range errors are safe to expose without exposing storage failure details. */
export class McpProgressRangeError extends Error {
  /** Preserve an actionable range-validation message for the MCP tool error response. */
  constructor(message: string) {
    super(message);
    this.name = 'McpProgressRangeError';
  }
}

/** Translate the shared date parser's failures into the explicitly public range-error category. */
function parseRangeDate(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new McpProgressRangeError(`${field} must be YYYY-MM-DD.`);
  try {
    return parseLocalDateOnly(value);
  } catch {
    throw new McpProgressRangeError(`${field} must be a valid calendar date.`);
  }
}

/** Resolve a date-only UTC value, defaulting to the account's local today; throw McpProgressRangeError for invalid/future input. */
export function resolveMcpEndDate(value: string | undefined, timezone: string, now: Date): Date {
  const today = getSafeUtcTodayDateOnlyInTimeZone(timezone, now);
  if (value === undefined) return today;
  const date = parseRangeDate(value, 'end_date');
  if (date > today) throw new McpProgressRangeError('Progress ranges cannot end after the account local day.');
  return date;
}

/** Resolve paired inclusive dates or ninety local days by default; throw McpProgressRangeError outside 1-365 days or for invalid bounds. */
export function resolveMcpProgressRange(input: ProgressRangeInput, timezone: string, now: Date): ProgressRange {
  if ((input.start_date === undefined) !== (input.end_date === undefined)) {
    throw new McpProgressRangeError('Supply both start_date and end_date, or neither.');
  }
  const end = resolveMcpEndDate(input.end_date, timezone, now);
  let start = addUtcDays(end, -(DEFAULT_PROGRESS_DAYS - 1));
  if (input.start_date !== undefined) {
    start = parseRangeDate(input.start_date, 'start_date');
  }
  const count = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
  if (count < 1 || count > MCP_MAX_PROGRESS_DAYS) throw new McpProgressRangeError('Progress ranges must contain 1-365 inclusive local days.');
  return { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10), day_count: count };
}
