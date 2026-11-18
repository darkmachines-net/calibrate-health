/** @file Weight-trend display evidence, freshness, uncertainty, and unavailable-state presentation. */

import type { TrendMetricEntry, WeightTrendSummary } from '@calibrate/api-client';
import type { WeightUnit } from '@calibrate/shared';
import { formatWeight } from '../utils/format';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MIN_DISPLAY_CHANGE_KG = 0.05; // Matches the one-decimal precision used for displayed kilogram weights.
const POUNDS_PER_KILOGRAM = 2.2046226218;

type VisibleTrendPoint = {
    dateMs: number;
    trendWeight: number;
};

export type WeightTrendSnapshot = {
    weight: number;
    lower: number;
    upper: number;
};

/** Distinguishes materialized trend points from raw context, retaining compatibility with older server flags. */
export function isVisibleWeightTrendPoint(metric: TrendMetricEntry): boolean {
    if (metric.trend_is_materialized === false || !Number.isFinite(metric.trend_weight)) return false;
    if (metric.trend_is_materialized === true) return true;

    // Older servers omitted the modeled flag and represented raw context with a zero-width
    // compatibility interval. Preserve their real modeled points without drawing that fallback.
    const hasPositiveStd = Number.isFinite(metric.trend_std) && metric.trend_std > 0;
    const hasPositiveInterval = Number.isFinite(metric.trend_ci_lower) &&
        Number.isFinite(metric.trend_ci_upper) &&
        metric.trend_ci_upper > metric.trend_ci_lower;
    return hasPositiveStd || hasPositiveInterval;
}

function isFiniteTrendSnapshot(snapshot: WeightTrendSnapshot | null | undefined): snapshot is WeightTrendSnapshot {
    return Boolean(
        snapshot &&
        Number.isFinite(snapshot.weight) &&
        Number.isFinite(snapshot.lower) &&
        Number.isFinite(snapshot.upper)
    );
}

/** Prefers a valid summary snapshot, otherwise finds the latest visible finite trend interval. */
export function getLatestWeightTrendSnapshot(
    metrics: TrendMetricEntry[],
    summary?: WeightTrendSummary
): WeightTrendSnapshot | null {
    if (isFiniteTrendSnapshot(summary?.latest_trend)) return summary.latest_trend;

    const latestMetric = metrics
        .filter((metric) => (
            isVisibleWeightTrendPoint(metric) &&
            Number.isFinite(metric.trend_ci_lower) &&
            Number.isFinite(metric.trend_ci_upper)
        ))
        .slice()
        .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime())[0];
    if (!latestMetric) return null;

    return {
        weight: latestMetric.trend_weight,
        lower: latestMetric.trend_ci_lower,
        upper: latestMetric.trend_ci_upper
    };
}

/** Formats the trend uncertainty interval in the selected weight units. */
export function formatEstimatedTrendRange(snapshot: WeightTrendSnapshot, unit: WeightUnit | undefined): string {
    return `${formatWeight(snapshot.lower, unit)} - ${formatWeight(snapshot.upper, unit)}`;
}

/**
 * Describe the endpoint-to-endpoint movement of the trend line currently shown.
 */
export function describeVisibleWeightTrend(
    metrics: TrendMetricEntry[],
    unit: WeightUnit | undefined
): string {
    const points = metrics
        .map<VisibleTrendPoint | null>((metric) => {
            const dateMs = new Date(metric.date).getTime();
            if (
                !isVisibleWeightTrendPoint(metric) ||
                !Number.isFinite(dateMs)
            ) {
                return null;
            }
            return {
                dateMs,
                trendWeight: metric.trend_weight
            };
        })
        .filter((point): point is VisibleTrendPoint => point !== null)
        .sort((a, b) => a.dateMs - b.dateMs);

    if (points.length < 2) {
        return 'Log another weigh-in to show the trend line change.';
    }

    const first = points[0];
    const last = points[points.length - 1];
    const spanDays = Math.max(1, Math.round((last.dateMs - first.dateMs) / MS_PER_DAY));
    const spanLabel = `${spanDays} ${spanDays === 1 ? 'day' : 'days'}`;
    const change = last.trendWeight - first.trendWeight;

    const minDisplayChange = unit === 'LB'
        ? MIN_DISPLAY_CHANGE_KG * POUNDS_PER_KILOGRAM
        : MIN_DISPLAY_CHANGE_KG;
    if (Math.abs(change) < minDisplayChange) {
        return `Trend line: steady over ${spanLabel}.`;
    }

    const direction = change > 0 ? 'up' : 'down';
    return `Trend line: ${direction} ${formatWeight(Math.abs(change), unit)} over ${spanLabel}.`;
}
