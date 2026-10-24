/** @file Regression coverage for geometry: weight trend chart geometry. */

import type { TrendMetricEntry } from '@calibrate/api-client';
import { buildWeightTrendChartGeometry, normalizeWeightTrendMetrics } from './geometry';

function metric(
    id: number,
    date: string,
    weight: number,
    options: { materialized?: boolean; segmentStart?: boolean } = {}
): TrendMetricEntry {
    const materialized = options.materialized ?? true;
    return {
        id,
        user_id: 1,
        date,
        weight,
        body_fat_percent: null,
        trend_is_materialized: materialized,
        trend_segment_start: options.segmentStart,
        trend_weight: materialized ? weight - 0.1 : weight,
        trend_ci_lower: materialized ? weight - 0.4 : weight,
        trend_ci_upper: materialized ? weight + 0.2 : weight,
        trend_std: materialized ? 0.15 : 0
    };
}

const OPTIONS = {
    width: 360,
    height: 200,
    minWidth: 280,
    minHeight: 180,
    minWeightSpan: 0.4,
    padding: { left: 50, right: 10, top: 10, bottom: 30 },
    xTickCount: 3 as const,
    yAxisMode: 'nice' as const
};

describe('weight trend chart geometry', () => {
    it('sorts API metrics by date instead of relying on response order', () => {
        const normalized = normalizeWeightTrendMetrics([
            metric(2, '2026-07-11', 79),
            metric(1, '2026-07-01', 80),
            metric(3, '2026-07-02', 79.8)
        ]);

        expect(normalized.map((point) => point.dateKey)).toEqual([
            '2026-07-01',
            '2026-07-02',
            '2026-07-11'
        ]);
    });

    it('positions observations by elapsed time rather than point index', () => {
        const geometry = buildWeightTrendChartGeometry([
            metric(3, '2026-07-11', 79),
            metric(2, '2026-07-02', 79.8),
            metric(1, '2026-07-01', 80)
        ], OPTIONS);

        const [first, second, last] = geometry.points;
        expect(first.x).toBe(50);
        expect(last.x).toBe(350);
        expect(second.x).toBeCloseTo(80, 5);
        expect(second.x).not.toBeCloseTo(200, 5);
    });

    it('breaks modeled paths across gaps longer than 14 days', () => {
        const geometry = buildWeightTrendChartGeometry([
            metric(4, '2026-07-25', 78.5),
            metric(3, '2026-07-24', 78.7),
            metric(2, '2026-07-01', 79.2),
            metric(1, '2026-06-30', 79.4)
        ], OPTIONS);

        expect(geometry.trendSegments.map((segment) => segment.map((point) => point.dateKey))).toEqual([
            ['2026-06-30', '2026-07-01'],
            ['2026-07-24', '2026-07-25']
        ]);
        expect(geometry.points[2].startsTrendSegment).toBe(true);
    });

    it('honors an explicit server segment boundary and identifies old measurement-only context', () => {
        const geometry = buildWeightTrendChartGeometry([
            metric(4, '2026-07-10', 78.8),
            metric(3, '2026-07-09', 79, { segmentStart: true }),
            metric(2, '2026-07-08', 79.2),
            metric(1, '2026-01-01', 82, { materialized: false })
        ], OPTIONS);

        expect(geometry.trendSegments).toHaveLength(2);
        expect(geometry.modelBoundaryPoint?.dateKey).toBe('2026-07-08');
        expect(geometry.points[0].hasVisibleTrend).toBe(false);
    });

    it('uses the summary modeled-window start for the boundary cue', () => {
        const geometry = buildWeightTrendChartGeometry([
            metric(3, '2026-07-10', 78.8),
            metric(2, '2026-07-08', 79.2),
            metric(1, '2026-01-01', 82, { materialized: false })
        ], {
            ...OPTIONS,
            modelStartDate: '2026-07-01'
        });

        expect(geometry.modelBoundaryPoint?.dateKey).toBe('2026-07-01');
        expect(geometry.modelBoundaryPoint?.x).toBeGreaterThan(OPTIONS.padding.left);
        expect(geometry.modelBoundaryPoint?.x).toBeLessThan(geometry.points[1].x);
    });

    it('downsamples dense raw history per pixel while retaining endpoints and extrema', () => {
        const start = Date.parse('2025-01-01T00:00:00.000Z');
        const metrics = Array.from({ length: 365 }, (_unused, index) => {
            const date = new Date(start + index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            const weight = 80 + Math.sin(index / 5) + (index === 180 ? 8 : 0);
            return metric(index + 1, date, weight, { materialized: false });
        });
        const geometry = buildWeightTrendChartGeometry(metrics, {
            ...OPTIONS,
            width: 80,
            minWidth: 80,
            padding: { ...OPTIONS.padding, left: 10, right: 10 },
            downsampleMeasurements: true
        });

        expect(geometry.points).toHaveLength(365);
        expect(geometry.measurementPoints.length).toBeLessThanOrEqual(60 * 4);
        expect(geometry.measurementPoints[0].metric.id).toBe(1);
        expect(geometry.measurementPoints[geometry.measurementPoints.length - 1]?.metric.id).toBe(365);
        expect(geometry.measurementPoints.some((point) => point.metric.id === 181)).toBe(true);
    });
});
