/** @file Canonical IANA-timezone local-day arithmetic and date-only parsing shared by server and clients. */

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Return an ISO local-date label (`YYYY-MM-DD`) for the given date/time and IANA timezone.
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
 * Validate the date-only wire format used by food logs, metrics, and day completion.
 */
export function isDateOnly(value: unknown): value is string {
    return typeof value === 'string' && DATE_ONLY_PATTERN.test(value);
}

/**
 * Parse a date-only string into a UTC-midnight Date suitable for Prisma `@db.Date` fields.
 */
export function parseDateOnlyAsUtcDate(value: string): Date | null {
    if (!isDateOnly(value)) {
        return null;
    }

    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}
