/** @file Deterministic SVG geometry for trend paths, uncertainty bands, ticks, and selected observations. */

import type { TrendMetricEntry } from '@calibrate/api-client';
import { isVisibleWeightTrendPoint } from './presentation';

const WEIGHT_TREND_SEGMENT_GAP_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TARGET_Y_AXIS_INTERVALS = 3;

type WeightTrendChartPadding = {
    left: number;
    right: number;
    top: number;
    bottom: number;
};

export type WeightTrendChartPoint = {
    metric: TrendMetricEntry;
    dateKey: string;
    dateMs: number;
    hasVisibleTrend: boolean;
    startsTrendSegment: boolean;
    x: number;
    measurementY: number;
    trendY: number;
    lowerY: number;
    upperY: number;
};

type WeightTrendModelBoundary = {
    dateKey: string;
    dateMs: number;
    x: number;
};

export type WeightTrendChartGeometry = {
    width: number;
    height: number;
    points: WeightTrendChartPoint[];
    /** Raw dots after optional per-pixel first/min/max/last downsampling. */
    measurementPoints: WeightTrendChartPoint[];
    trendSegments: WeightTrendChartPoint[][];
    modelBoundaryPoint: WeightTrendModelBoundary | null;
    yTicks: Array<{ value: number; y: number }>;
    xTicks: Array<{
        key: string;
        dateKey: string;
        x: number;
        textAnchor: 'start' | 'middle' | 'end';
    }>;
};

/** Builds the SVG trend polyline path from ordered chart points with stable coordinate precision. */
export function buildWeightTrendLinePath(points: WeightTrendChartPoint[]): string {
    return points
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.trendY.toFixed(2)}`)
        .join(' ');
}

/** Builds a closed confidence-band polygon by joining upper points with reversed lower points. */
export function buildWeightTrendBandPoints(points: WeightTrendChartPoint[]): string {
    const upper = points.map((point) => `${point.x.toFixed(2)},${point.upperY.toFixed(2)}`);
    const lower = points.slice().reverse().map((point) => `${point.x.toFixed(2)},${point.lowerY.toFixed(2)}`);
    return [...upper, ...lower].join(' ');
}

type WeightTrendChartGeometryOptions = {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    minWeightSpan: number;
    padding: WeightTrendChartPadding;
    xTickCount?: 2 | 3;
    yAxisMode?: 'nice' | 'bounds';
    downsampleMeasurements?: boolean;
    modelStartDate?: string | null;
};

/**
 * Bound dense raw history to first/min/max/last per horizontal pixel bucket.
 * Trend geometry stays complete; this only controls measurement-dot rendering.
 */
function downsampleWeightTrendMeasurements(
    points: WeightTrendChartPoint[],
    drawableWidth: number,
    leftEdge: number
): WeightTrendChartPoint[] {
    const bucketCount = Math.max(1, Math.floor(drawableWidth));
    if (points.length <= bucketCount) return points;

    const buckets = new Map<number, Array<{ point: WeightTrendChartPoint; index: number }>>();
    for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        const bucket = Math.max(0, Math.min(
            bucketCount - 1,
            Math.floor(((point.x - leftEdge) / Math.max(1, drawableWidth)) * bucketCount)
        ));
        const entries = buckets.get(bucket) ?? [];
        entries.push({ point, index });
        buckets.set(bucket, entries);
    }

    const retained = new Map<number, WeightTrendChartPoint>();
    for (const entries of buckets.values()) {
        const minimum = entries.reduce((best, entry) => (
            entry.point.metric.weight < best.point.metric.weight ? entry : best
        ));
        const maximum = entries.reduce((best, entry) => (
            entry.point.metric.weight > best.point.metric.weight ? entry : best
        ));
        for (const entry of [entries[0], minimum, maximum, entries[entries.length - 1]]) {
            retained.set(entry.index, entry.point);
        }
    }

    // Global endpoints must survive even if future bucket logic changes.
    retained.set(0, points[0]);
    retained.set(points.length - 1, points[points.length - 1]);
    return [...retained.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, point]) => point);
}

function getWeightTrendDateKey(value: string): string {
    return value.split('T')[0] ?? value;
}

function parseDateKey(value: string): number | null {
    const [year, month, day] = getWeightTrendDateKey(value).split('-').map(Number);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    const dateMs = Date.UTC(year, month - 1, day);
    const date = new Date(dateMs);
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }
    return dateMs;
}

function dateKeyFromMs(value: number): string {
    return new Date(value).toISOString().slice(0, 10);
}

/** Filters invalid observations and normalizes dates while distinguishing modeled trend from raw context. */
export function normalizeWeightTrendMetrics(metrics: TrendMetricEntry[]): Array<{
    metric: TrendMetricEntry;
    dateKey: string;
    dateMs: number;
    hasVisibleTrend: boolean;
}> {
    return metrics
        .flatMap((metric) => {
            const dateMs = parseDateKey(metric.date);
            if (dateMs === null || !Number.isFinite(metric.weight)) return [];
            const hasFiniteInterval = Number.isFinite(metric.trend_ci_lower) && Number.isFinite(metric.trend_ci_upper);
            return [{
                metric,
                dateKey: getWeightTrendDateKey(metric.date),
                dateMs,
                hasVisibleTrend: isVisibleWeightTrendPoint(metric) && hasFiniteInterval
            }];
        })
        .sort((left, right) => left.dateMs - right.dateMs || left.metric.id - right.metric.id);
}

function getNiceTickStep(range: number): number {
    const roughStep = range / TARGET_Y_AXIS_INTERVALS;
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const normalizedStep = roughStep / magnitude;

    if (normalizedStep <= 1) return magnitude;
    if (normalizedStep <= 2) return magnitude * 2;
    if (normalizedStep <= 2.5) return magnitude * 2.5;
    if (normalizedStep <= 5) return magnitude * 5;
    return magnitude * 10;
}

function roundTickValue(value: number): number {
    return Number(value.toPrecision(12));
}

function getXAxisTickFractions(count: 2 | 3): number[] {
    return count === 2 ? [0, 1] : [0, 0.5, 1];
}

/** Computes bounded chart dimensions, axes, observed points, trend segments, and model-boundary geometry. */
export function buildWeightTrendChartGeometry(
    metrics: TrendMetricEntry[],
    options: WeightTrendChartGeometryOptions
): WeightTrendChartGeometry {
    const normalized = normalizeWeightTrendMetrics(metrics);
    const width = Math.max(options.width, options.minWidth);
    const height = Math.max(options.height, options.minHeight);
    if (normalized.length === 0) {
        return {
            width,
            height,
            points: [],
            measurementPoints: [],
            trendSegments: [],
            modelBoundaryPoint: null,
            yTicks: [],
            xTicks: []
        };
    }

    const values = normalized.flatMap((point) => point.hasVisibleTrend
        ? [point.metric.weight, point.metric.trend_weight, point.metric.trend_ci_lower, point.metric.trend_ci_upper]
        : [point.metric.weight]
    );
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const value of values) {
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
    }
    const requestedRange = Math.max(maximum - minimum, options.minWeightSpan);
    let axisMinimum: number;
    let axisMaximum: number;
    let yTicks: WeightTrendChartGeometry['yTicks'];

    if (options.yAxisMode === 'bounds') {
        const middle = (minimum + maximum) / 2;
        axisMinimum = middle - requestedRange / 2;
        axisMaximum = middle + requestedRange / 2;
        yTicks = [];
    } else {
        const step = getNiceTickStep(requestedRange);
        axisMinimum = Math.floor(minimum / step) * step;
        axisMaximum = Math.ceil(maximum / step) * step;
        if (Math.abs(minimum - axisMinimum) < Number.EPSILON * 100) axisMinimum -= step;
        if (Math.abs(maximum - axisMaximum) < Number.EPSILON * 100) axisMaximum += step;
        if (axisMinimum === axisMaximum) {
            axisMinimum -= step;
            axisMaximum += step;
        }
        axisMinimum = roundTickValue(axisMinimum);
        axisMaximum = roundTickValue(axisMaximum);
        yTicks = [];
        for (let value = axisMinimum; value <= axisMaximum + step / 2; value += step) {
            yTicks.push({ value: roundTickValue(value), y: 0 });
        }
    }

    const axisRange = axisMaximum - axisMinimum;
    const drawableWidth = width - options.padding.left - options.padding.right;
    const drawableHeight = height - options.padding.top - options.padding.bottom;
    const firstDateMs = normalized[0].dateMs;
    const lastDateMs = normalized[normalized.length - 1].dateMs;
    const dateRangeMs = Math.max(MS_PER_DAY, lastDateMs - firstDateMs);
    const xForDate = (dateMs: number) =>
        options.padding.left + ((dateMs - firstDateMs) / dateRangeMs) * drawableWidth;
    const yForValue = (value: number) =>
        options.padding.top + drawableHeight - ((value - axisMinimum) / axisRange) * drawableHeight;

    yTicks = options.yAxisMode === 'bounds'
        ? [
            { value: axisMaximum, y: options.padding.top },
            { value: axisMinimum, y: height - options.padding.bottom }
        ]
        : yTicks.map((tick) => ({ ...tick, y: yForValue(tick.value) }));

    let previousModeledDateMs: number | null = null;
    let previousWasModeled = false;
    const points = normalized.map<WeightTrendChartPoint>((point) => {
        const gapDays = previousModeledDateMs === null ? Number.POSITIVE_INFINITY :
            (point.dateMs - previousModeledDateMs) / MS_PER_DAY;
        const startsTrendSegment = point.hasVisibleTrend && (
            point.metric.trend_segment_start === true ||
            !previousWasModeled ||
            gapDays > WEIGHT_TREND_SEGMENT_GAP_DAYS
        );
        if (point.hasVisibleTrend) previousModeledDateMs = point.dateMs;
        previousWasModeled = point.hasVisibleTrend;
        const measurementY = yForValue(point.metric.weight);
        return {
            ...point,
            startsTrendSegment,
            x: xForDate(point.dateMs),
            measurementY,
            trendY: point.hasVisibleTrend ? yForValue(point.metric.trend_weight) : measurementY,
            lowerY: point.hasVisibleTrend ? yForValue(point.metric.trend_ci_lower) : measurementY,
            upperY: point.hasVisibleTrend ? yForValue(point.metric.trend_ci_upper) : measurementY
        };
    });

    const trendSegments: WeightTrendChartPoint[][] = [];
    for (const point of points) {
        if (!point.hasVisibleTrend) continue;
        if (point.startsTrendSegment || trendSegments.length === 0) trendSegments.push([]);
        trendSegments[trendSegments.length - 1].push(point);
    }

    const firstModeledIndex = points.findIndex((point) => point.hasVisibleTrend);
    const modeledStartMs = options.modelStartDate ? parseDateKey(options.modelStartDate) : null;
    const hasExplicitBoundary = modeledStartMs !== null &&
        modeledStartMs > firstDateMs &&
        modeledStartMs <= lastDateMs &&
        points.some((point) => point.hasVisibleTrend && point.dateMs >= modeledStartMs);
    let modelBoundaryPoint: WeightTrendModelBoundary | null = null;
    if (hasExplicitBoundary) {
        modelBoundaryPoint = {
            dateKey: dateKeyFromMs(modeledStartMs),
            dateMs: modeledStartMs,
            x: xForDate(modeledStartMs)
        };
    } else if (firstModeledIndex > 0) {
        modelBoundaryPoint = {
            dateKey: points[firstModeledIndex].dateKey,
            dateMs: points[firstModeledIndex].dateMs,
            x: points[firstModeledIndex].x
        };
    }
    const xTickCount = options.xTickCount ?? 3;
    const xTicks = getXAxisTickFractions(xTickCount).map((fraction, index, fractions) => {
        const dateMs = firstDateMs + (lastDateMs - firstDateMs) * fraction;
        let textAnchor: 'start' | 'middle' | 'end' = 'middle';
        if (index === 0) textAnchor = 'start';
        if (index === fractions.length - 1) textAnchor = 'end';
        return {
            key: `date-${dateKeyFromMs(dateMs)}-${index}`,
            dateKey: dateKeyFromMs(dateMs),
            x: xForDate(dateMs),
            textAnchor
        };
    });

    const measurementPoints = options.downsampleMeasurements
        ? downsampleWeightTrendMeasurements(points, drawableWidth, options.padding.left)
        : points;

    return { width, height, points, measurementPoints, trendSegments, modelBoundaryPoint, yTicks, xTicks };
}
