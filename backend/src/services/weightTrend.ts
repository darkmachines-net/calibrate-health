/** @file weight Trend: Selected persistence/API model version. Changing it invalidates materialized rows. */

import {
    classifyWeightTrendEvidence,
    computeWeightTrend as computeWeightTrendV2,
    WEIGHT_TREND_MODEL_VERSION as WEIGHT_TREND_MODEL_VERSION_V2,
    type WeightTrendEvidence,
    type WeightTrendObservation,
    type WeightTrendOptions,
    type WeightTrendPoint,
    type WeightTrendResult,
    type WeightTrendSegment
} from '../../../shared/weightTrend';
import { computeWeightTrendV1, type WeightTrendResult as WeightTrendResultV1 } from './weightTrendV1';

export * from '../../../shared/weightTrend';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const USE_WEIGHT_TREND_V1 = process.env.WEIGHT_TREND_MODEL?.trim().toLowerCase() === 'v1';

/** Selected persistence/API model version. Changing it invalidates materialized rows. */
export const WEIGHT_TREND_MODEL_VERSION: 1 | 2 = USE_WEIGHT_TREND_V1
    ? 1
    : WEIGHT_TREND_MODEL_VERSION_V2;

function isValidDate(value: Date | undefined): value is Date {
    return value instanceof Date && Number.isFinite(value.getTime());
}

function elapsedDays(startDate: Date, endDate: Date): number {
    const value = (endDate.getTime() - startDate.getTime()) / MS_PER_DAY;
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function buildLegacyEvidence(points: WeightTrendPoint[]): WeightTrendEvidence {
    if (points.length === 0) {
        return {
            pointCount: 0,
            spanDays: 0,
            segmentCount: 0,
            latestSegmentPointCount: 0,
            latestSegmentSpanDays: 0,
            effectiveObservationCount: 0,
            status: 'insufficient'
        };
    }

    const spanDays = elapsedDays(points[0].date, points[points.length - 1].date);
    return {
        pointCount: points.length,
        spanDays,
        segmentCount: 1,
        latestSegmentPointCount: points.length,
        latestSegmentSpanDays: spanDays,
        effectiveObservationCount: points.length,
        status: classifyWeightTrendEvidence(points.length, spanDays, points.length)
    };
}

function buildLegacySegments(points: WeightTrendPoint[]): WeightTrendSegment[] {
    if (points.length === 0) return [];

    return [{
        id: 1,
        startIndex: 0,
        endIndex: points.length - 1,
        startDate: points[0].date,
        endDate: points[points.length - 1].date,
        pointCount: points.length,
        spanDays: elapsedDays(points[0].date, points[points.length - 1].date),
        effectiveObservationCount: points.length,
        resetGapDays: null
    }];
}

function adaptWeightTrendV1Result(
    legacy: WeightTrendResultV1,
    explicitAsOfDate: Date | undefined
): WeightTrendResult {
    const points = legacy.points.map<WeightTrendPoint>((point, index) => ({
        ...point,
        trendRatePerDay: Number.NaN,
        trendRateStdPerDay: Number.NaN,
        trendRateLower95PerDay: Number.NaN,
        trendRateUpper95PerDay: Number.NaN,
        segmentId: 1,
        isSegmentStart: index === 0,
        gapDays: index === 0 ? 0 : elapsedDays(legacy.points[index - 1].date, point.date),
        huberWeight: 1
    }));
    const evidence = buildLegacyEvidence(points);
    const lastPoint = points[points.length - 1];
    let asOfDate: Date | null = null;
    if (isValidDate(explicitAsOfDate)) {
        asOfDate = new Date(explicitAsOfDate.getTime());
    } else if (lastPoint) {
        asOfDate = new Date(lastPoint.date.getTime());
    }

    return {
        points,
        weeklyRate: legacy.weeklyRate,
        volatility: legacy.volatility,
        currentRate: {
            estimateKgPerWeek: Number.NaN,
            stdKgPerWeek: Number.NaN,
            lower95KgPerWeek: Number.NaN,
            upper95KgPerWeek: Number.NaN,
            pointCount: 0,
            spanDays: 0,
            direction: 'uncertain',
            status: 'insufficient'
        },
        windowAverageRate: {
            estimateKgPerWeek: Number.NaN,
            stdKgPerWeek: Number.NaN,
            lower95KgPerWeek: Number.NaN,
            upper95KgPerWeek: Number.NaN,
            pointCount: 0,
            spanDays: 0,
            direction: 'uncertain',
            status: 'insufficient'
        },
        measurementVariabilityKg: Math.sqrt(legacy.params.measurementVariance),
        evidence,
        segments: buildLegacySegments(points),
        asOfDate,
        params: {
            ...legacy.params,
            huberK: Number.NaN,
            segmentResetDays: Number.NaN
        }
    };
}

/**
 * Resolve the configured rollout model while preserving the shared v2 result contract.
 * `WEIGHT_TREND_MODEL=v1` is an operational rollback; every other value uses v2.
 */
export function computeWeightTrend(
    observations: WeightTrendObservation[],
    options: WeightTrendOptions = {}
): WeightTrendResult {
    if (!USE_WEIGHT_TREND_V1) return computeWeightTrendV2(observations, options);

    let legacyObservations = observations;
    if (isValidDate(options.asOfDate)) {
        const cutoffMs = options.asOfDate.getTime();
        legacyObservations = observations.filter((observation) => observation.date.getTime() <= cutoffMs);
    }
    return adaptWeightTrendV1Result(computeWeightTrendV1(legacyObservations), options.asOfDate);
}
