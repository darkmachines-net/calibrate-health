/** @file Regression coverage for presentation: describeVisibleWeightTrend. */

import type { TrendMetricEntry } from '@calibrate/api-client';
import type { WeightTrendSummary } from '@calibrate/api-client';
import {
    describeVisibleWeightTrend,
    formatEstimatedTrendRange,
    getLatestWeightTrendSnapshot,
    isVisibleWeightTrendPoint
} from './presentation';

function createMetric(
    id: number,
    date: string,
    trendWeight: number,
    trendIsMaterialized = true
): TrendMetricEntry {
    return {
        id,
        user_id: 1,
        date,
        weight: trendWeight,
        body_fat_percent: null,
        trend_is_materialized: trendIsMaterialized,
        trend_weight: trendWeight,
        trend_ci_lower: trendWeight - 0.5,
        trend_ci_upper: trendWeight + 0.5,
        trend_std: 0.2
    };
}

describe('describeVisibleWeightTrend', () => {
    it('describes the visible trend endpoints instead of an unrelated weekly rate', () => {
        const metrics = [
            createMetric(3, '2026-07-20', 168.2),
            createMetric(2, '2026-07-12', 168.8),
            createMetric(1, '2026-07-01', 169.4)
        ];

        expect(describeVisibleWeightTrend(metrics, 'LB'))
            .toBe('Trend line: down 1.2 lb over 19 days.');
    });

    it('uses plain-language upward and steady summaries', () => {
        expect(describeVisibleWeightTrend([
            createMetric(2, '2026-07-08', 80.4),
            createMetric(1, '2026-07-01', 80)
        ], 'KG')).toBe('Trend line: up 0.4 kg over 7 days.');

        expect(describeVisibleWeightTrend([
            createMetric(2, '2026-07-08', 80.03),
            createMetric(1, '2026-07-01', 80)
        ], 'KG')).toBe('Trend line: steady over 7 days.');
    });

    it('uses one canonical steady threshold across kilograms and pounds', () => {
        expect(describeVisibleWeightTrend([
            createMetric(2, '2026-07-08', 180.09),
            createMetric(1, '2026-07-01', 180)
        ], 'LB')).toBe('Trend line: steady over 7 days.');

        expect(describeVisibleWeightTrend([
            createMetric(2, '2026-07-08', 180.12),
            createMetric(1, '2026-07-01', 180)
        ], 'LB')).toBe('Trend line: up 0.1 lb over 7 days.');
    });

    it('ignores Year and All fallback points older than the materialized horizon', () => {
        const metrics = [
            createMetric(3, '2026-07-20', 168.5),
            createMetric(2, '2026-03-23', 170),
            createMetric(1, '2025-07-20', 210, false)
        ];

        expect(describeVisibleWeightTrend(metrics, 'LB'))
            .toBe('Trend line: down 1.5 lb over 119 days.');
    });

    it('accepts missing materialization metadata from legacy API v1 servers', () => {
        const metrics = [
            createMetric(2, '2026-07-20', 168.2),
            createMetric(1, '2026-07-01', 169.4)
        ];
        delete metrics[0].trend_is_materialized;
        delete metrics[1].trend_is_materialized;

        expect(describeVisibleWeightTrend(metrics, 'LB'))
            .toBe('Trend line: down 1.2 lb over 19 days.');
    });

    it('hides legacy zero-width fallback points when modeled metadata is absent', () => {
        const fallback = createMetric(2, '2025-07-20', 210);
        delete fallback.trend_is_materialized;
        fallback.trend_ci_lower = fallback.weight;
        fallback.trend_ci_upper = fallback.weight;
        fallback.trend_std = 0;

        expect(isVisibleWeightTrendPoint(fallback)).toBe(false);
        expect(describeVisibleWeightTrend([
            createMetric(3, '2026-07-20', 168.5),
            fallback
        ], 'LB')).toBe('Log another weigh-in to show the trend line change.');
    });

    it('requires two genuinely materialized endpoints', () => {
        const metrics = [
            createMetric(3, '2026-07-20', 168.5),
            createMetric(2, '2025-07-20', 210, false)
        ];

        expect(describeVisibleWeightTrend(metrics, 'LB'))
            .toBe('Log another weigh-in to show the trend line change.');
    });

    it('prefers the additive v2 snapshot and formats its estimated range', () => {
        const summary: WeightTrendSummary = {
            status: 'sufficient',
            evidence: 'sufficient',
            freshness: 'current',
            model_version: 2,
            as_of_date: '2026-07-20',
            scope_start_date: '2026-06-22',
            scope_end_date: '2026-07-20',
            latest_observation_date: '2026-07-20',
            days_since_latest: 0,
            modeled_points: 10,
            observation_span_days: 28,
            segment_start_date: '2026-06-22',
            latest_trend: { weight: 168.25, lower: 167.7, upper: 168.8 },
            weekly_rate: null,
            short_term_variation: null
        };

        const snapshot = getLatestWeightTrendSnapshot([createMetric(1, '2026-07-19', 170)], summary);
        expect(snapshot).toEqual(summary.latest_trend);
        expect(snapshot && formatEstimatedTrendRange(snapshot, 'LB')).toBe('167.7 lb - 168.8 lb');
    });

    it('falls back to the newest modeled point for legacy servers', () => {
        const metrics = [
            createMetric(1, '2026-07-01', 170),
            createMetric(3, '2026-07-20', 168),
            createMetric(2, '2026-07-10', 169)
        ];

        expect(getLatestWeightTrendSnapshot(metrics)).toEqual({
            weight: 168,
            lower: 167.5,
            upper: 168.5
        });
    });

});
