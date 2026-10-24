/** @file Client account-timezone date labels, navigation, and API date-boundary helpers. */

import { formatDateOnlyInTimeZone } from '@calibrate/shared';

/** Returns today's date in the account timezone, defaulting to UTC when none is supplied. */
export function getTodayDate(timezone?: string | null): string {
    return formatDateOnlyInTimeZone(new Date(), timezone || 'UTC');
}

/** Converts a valid timestamp to the account's local date, returning null for missing or invalid input. */
export function getLocalDateForTimestamp(timestamp: string | null | undefined, timezone?: string | null): string | null {
    if (!timestamp) return null;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;
    return formatDateOnlyInTimeZone(date, timezone || 'UTC');
}

/** Adds calendar days to a canonical date-only string using UTC arithmetic. */
export function addDaysToDateOnly(value: string, days: number): string {
    const [yearString, monthString, dayString] = value.split('-');
    const year = Number(yearString);
    const month = Number(monthString);
    const day = Number(dayString);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

/** Creates a local calendar Date for date-picker interoperability without UTC parsing shifts. */
export function dateOnlyToLocalDate(value: string): Date {
    const [yearString, monthString, dayString] = value.split('-');
    return new Date(Number(yearString), Number(monthString) - 1, Number(dayString));
}

/** Serializes the local calendar fields of a Date into a canonical date-only string. */
export function localDateToDateOnly(value: Date): string {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** Clamps a canonical date-only string to inclusive canonical date bounds. */
export function clampDateOnly(value: string, min: string, max: string): string {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

/** Formats a date-only value through local calendar fields, preserving invalid input as a fallback. */
export function formatDateOnlyForDisplay(value: string): string {
    const [yearString, monthString, dayString] = value.split('-');
    const year = Number(yearString);
    const month = Number(monthString);
    const day = Number(dayString);
    const date = new Date(year, month - 1, day);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}
