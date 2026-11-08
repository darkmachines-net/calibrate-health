/** @file Calendar-day viewport and request bounds for the pannable weight history. */

// UTC arithmetic on date-only values avoids DST changes in the number of visible days.
export const WEIGHT_HISTORY_DAY_MS = 86_400_000;
// One page covers two Month windows. Fetch a neighbor while the current page is still visible.
export const WEIGHT_HISTORY_PAGE_DAYS = 56;
export const WEIGHT_HISTORY_RANGES = [
    { label: 'Week', days: 7 },
    { label: 'Month', days: 28 },
    { label: 'Year', days: 365 }
] as const;

export type WeightHistoryRange = (typeof WEIGHT_HISTORY_RANGES)[number]['days'];

/** Converts a date-only value or ISO API date to a sortable day index. */
export function weightHistoryDay(date: string): number {
    return Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / WEIGHT_HISTORY_DAY_MS;
}

/** Formats a day index as a canonical date-only query value, rounding an in-progress pan. */
export function weightHistoryDate(day: number): string {
    return new Date(Math.round(day) * WEIGHT_HISTORY_DAY_MS).toISOString().slice(0, 10);
}

/** Returns a non-overlapping inclusive page anchored to the latest account-local day. */
export function weightHistoryPage(today: number, page: number) {
    const end = today - page * WEIGHT_HISTORY_PAGE_DAYS;
    return { start: weightHistoryDate(end - WEIGHT_HISTORY_PAGE_DAYS + 1), end: weightHistoryDate(end) };
}

/** Maps a day to its history page; values at the present edge belong to page zero. */
export function weightHistoryPageIndex(today: number, day: number): number {
    return Math.max(0, Math.floor((today - day) / WEIGHT_HISTORY_PAGE_DAYS));
}
