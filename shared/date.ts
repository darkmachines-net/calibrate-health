/** @file IANA-timezone local-day formatting and date-only wire validation shared by server and clients. */

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Return a local-date label (`YYYY-MM-DD`) for the given instant and timezone.
 * If formatting fails, use the instant's UTC date; an invalid Date still throws.
 */
export function formatDateOnlyInTimeZone(date: Date, timeZone: string): string {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(date);
        const year = parts.find((part) => part.type === 'year')?.value;
        const month = parts.find((part) => part.type === 'month')?.value;
        const day = parts.find((part) => part.type === 'day')?.value;
        if (year && month && day) {
            return `${year}-${month}-${day}`;
        }
    } catch {
        // Fall through to UTC below when the runtime lacks timezone support for the requested zone.
    }

    return date.toISOString().slice(0, 10);
}

/**
 * Check only the YYYY-MM-DD wire format; this does not validate the calendar date.
 */
export function isDateOnly(value: unknown): value is string {
    return typeof value === 'string' && DATE_ONLY_PATTERN.test(value);
}
