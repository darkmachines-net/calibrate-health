/** @file Pure descriptive tracking windows shared with synthetic previews; no persistence or calorie-target decisions. */

import { PLAN_CHECK_WINDOWS, type PlanCheckSummary, type PlanCheckWindow } from '../../../shared/planCheck';
import { addUtcDays, MS_PER_DAY } from '../utils/date';

type TrackingEvidence = {
    localDate: Date;
    trackingSince: Date | null;
    weightUnit: 'KG' | 'LB';
    weights: Array<{ date: Date; weight_grams: number }>;
    food: Array<{ local_date: Date; calories: number }>;
    days: Array<{ local_date: Date; status: string }>;
};

function dateKey(date: Date): string { return date.toISOString().slice(0, 10); }

/** Summarize completed calendar windows; weight rates need recent readings spanning at least half the window. */
export function summarizeTracking(evidence: TrackingEvidence): PlanCheckSummary {
    const { localDate, trackingSince, weightUnit } = evidence;
    const trackingDays = trackingSince ? Math.max(0, Math.floor((+localDate - +trackingSince) / MS_PER_DAY)) : 0;
    const weights = evidence.weights.filter(row => row.date <= localDate && row.weight_grams > 0)
        .sort((a, b) => +a.date - +b.date);
    const latest = weights.at(-1);
    const needsWeighIn = !latest || latest.date < addUtcDays(localDate, -1);
    const windows: PlanCheckWindow[] = PLAN_CHECK_WINDOWS.filter(days => trackingDays >= days).map(days => {
        const start = addUtcDays(localDate, -days);
        const end = addUtcDays(localDate, -1);
        const totals = new Map<string, number>();
        const foodDays = evidence.days.filter(row => row.local_date >= start && row.local_date <= end);
        // Explicitly completed empty days represent zero; absent and unfinished empty days do not.
        for (const row of foodDays) if (row.status === 'COMPLETE') totals.set(dateKey(row.local_date), 0);
        for (const row of evidence.food) {
            if (row.local_date < start || row.local_date > end) continue;
            const key = dateKey(row.local_date);
            totals.set(key, (totals.get(key) ?? 0) + row.calories);
        }
        // Today's measurement may refresh weight evidence; today's unfinished intake is excluded.
        const readings = weights.filter(row => row.date >= start);
        const first = readings[0];
        const last = readings.at(-1);
        const span = first && last ? (+last.date - +first.date) / MS_PER_DAY : 0;
        const available = !needsWeighIn && readings.length >= 2 && span >= days / 2;
        let rate: number | null = null;
        if (available) {
            const points = readings.map(row => ({ x: (+row.date - +start) / MS_PER_DAY, y: row.weight_grams / 1000 }));
            const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
            const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
            const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
            rate = 7 * points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator;
        }
        return {
            days, startDate: dateKey(start), endDate: dateKey(end),
            loggedFoodDays: totals.size,
            completeFoodDays: foodDays.filter(row => row.status === 'COMPLETE').length,
            averageLoggedCalories: totals.size ? Math.round([...totals.values()].reduce((sum, value) => sum + value, 0) / totals.size) : null,
            weighIns: readings.length, weightSpanDays: span,
            weightChangeKg: available && first && last ? (last.weight_grams - first.weight_grams) / 1000 : null,
            weeklyWeightChangeKg: rate
        };
    });
    return {
        localDate: dateKey(localDate), trackingSince: trackingSince ? dateKey(trackingSince) : null,
        trackingDays, weightUnit, latestWeighInDate: latest ? dateKey(latest.date) : null, needsWeighIn, windows
    };
}
