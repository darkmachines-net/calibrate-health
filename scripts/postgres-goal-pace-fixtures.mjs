/** @file Calendar fixtures shared by the goal-pace PostgreSQL smoke scenarios. */

/** Keep timezone-overlap rows separate from today's and historical-create rows. */
export function goalPaceFixtureDates(now) {
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);
    const dayKey = (daysAgo) => {
        const date = new Date(today);
        date.setUTCDate(date.getUTCDate() - daysAgo);
        return date.toISOString().slice(0, 10);
    };
    // Leave a gap between the timezone scenarios and the historical create.
    const timezoneUtcDay = dayKey(7);
    const timezonePreviousDay = dayKey(8);
    return {
        today,
        historicalDay: dayKey(3),
        timezoneUtcDay,
        timezonePreviousDay,
        // At 06:59 UTC, Los Angeles is still on the previous day in both DST regimes.
        timezoneNow: `${timezoneUtcDay}T06:59:00Z`,
        metricGoalCreatedAt: `${timezonePreviousDay}T19:00:00Z`,
        importGoalCreatedAt: `${timezoneUtcDay}T01:00:00Z`,
    };
}
