/** @file Weight-trend display evidence, freshness, uncertainty, and unavailable-state presentation. */

import type { TrendMetricEntry, TrendMetricsResponse, WeightTrendSummary } from '@calibrate/api-client';
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

export type ShortTermVariationPresentation = {
    value: string;
    explanation: string;
};

export type WeeklyPacePresentation = {
    value: string;
    range: string;
    evidence: string;
    freshnessNote: string | null;
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

/** Presents finite short-term variation evidence or returns null when the model has no usable estimate. */
export function getShortTermVariationPresentation(
    response: TrendMetricsResponse | undefined,
    unit: WeightUnit | undefined
): ShortTermVariationPresentation | null {
    const variation = response?.meta.trend_summary?.short_term_variation;
    if (
        !variation ||
        !Number.isFinite(variation.standard_deviation) ||
        !Number.isFinite(variation.central_80_half_width)
    ) {
        return null;
    }

    const halfWidth = formatWeight(Math.max(0, variation.central_80_half_width), unit);
    return {
        value: `About 80% within +/- ${halfWidth}`,
        explanation: 'Hydration, meals, timing, and scale noise can shift individual readings.'
    };
}

function formatSignedWeeklyRate(value: number, unit: WeightUnit | undefined): string {
    const sign = value > 0 ? '+' : value < 0 ? '-' : '';
    return `${sign}${formatWeight(Math.abs(value), unit)}/week`;
}

/** Presents weekly pace and uncertainty only while the summary remains usable and sufficiently fresh. */
export function getWeeklyPacePresentation(
    summary: WeightTrendSummary | undefined,
    unit: WeightUnit | undefined
): WeeklyPacePresentation | null {
    const rate = summary?.weekly_rate;
    const freshness = summary?.freshness ?? (summary?.status === 'stale' ? 'stale' : 'current');
    if (
        !rate ||
        freshness === 'outdated' ||
        !Number.isFinite(rate.estimate) ||
        !Number.isFinite(rate.lower) ||
        !Number.isFinite(rate.upper)
    ) {
        return null;
    }

    const steadyThreshold = unit === 'LB'
        ? MIN_DISPLAY_CHANGE_KG * POUNDS_PER_KILOGRAM
        : MIN_DISPLAY_CHANGE_KG;
    let value = 'Steady';
    if (Math.abs(rate.estimate) >= steadyThreshold) {
        value = `${rate.estimate > 0 ? 'Up' : 'Down'} ${formatWeight(Math.abs(rate.estimate), unit)}/week`;
    }

    const pointLabel = rate.point_count === 1 ? 'weigh-in' : 'weigh-ins';
    const dayLabel = rate.span_days === 1 ? 'day' : 'days';
    const evidencePrefix = rate.evidence === 'sufficient' ? 'Based on' : 'Provisional estimate from';
    return {
        value,
        range: `${formatSignedWeeklyRate(rate.lower, unit)} to ${formatSignedWeeklyRate(rate.upper, unit)}`,
        evidence: `${evidencePrefix} ${rate.point_count} ${pointLabel} across ${rate.span_days} ${dayLabel}.`,
        freshnessNote: freshness === 'stale'
            ? 'This pace is based on an older weigh-in. Log a current weight to refresh it.'
            : null
    };
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
