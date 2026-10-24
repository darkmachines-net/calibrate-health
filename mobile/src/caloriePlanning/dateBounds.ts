/** @file date Bounds: Oldest selectable DOB that can still be age 120 on the supplied local date. */

/** Oldest selectable DOB that can still be age 120 on the supplied local date. */
export function getMinimumDateOfBirth(localToday: string): string {
    const [year, month, day] = localToday.split('-').map(Number);
    if (!year || !month || !day) return '';
    const targetYear = year - 121;
    const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
    const anniversary = new Date(Date.UTC(targetYear, month - 1, Math.min(day, lastDay)));
    anniversary.setUTCDate(anniversary.getUTCDate() + 1);
    return anniversary.toISOString().slice(0, 10);
}
