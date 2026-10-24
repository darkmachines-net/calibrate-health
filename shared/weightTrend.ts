/** @file Deterministic weight-trend filtering, uncertainty propagation, freshness, and display evidence policy. */

import { WEIGHT_TREND_PARAMETER_MANIFEST } from './weightTrendParameters';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const WEIGHT_TREND_MODEL_VERSION = WEIGHT_TREND_PARAMETER_MANIFEST.modelVersion;
export const WEIGHT_TREND_SEGMENT_RESET_DAYS = WEIGHT_TREND_PARAMETER_MANIFEST.filter.segmentResetDays;
export const WEIGHT_TREND_HUBER_K = WEIGHT_TREND_PARAMETER_MANIFEST.filter.huberK;
/** Default exact-window pace scope used by calibration scenarios and tuning gates. */
export const WEIGHT_TREND_RATE_WINDOW_DAYS = WEIGHT_TREND_PARAMETER_MANIFEST.calibrationWindowAverageRate.defaultWindowDays;
export const WEIGHT_TREND_MIN_RATE_WINDOW_DAYS = WEIGHT_TREND_PARAMETER_MANIFEST.calibrationWindowAverageRate.minimumWindowDays;
export const WEIGHT_TREND_MAX_RATE_WINDOW_DAYS = WEIGHT_TREND_PARAMETER_MANIFEST.calibrationWindowAverageRate.maximumWindowDays;

const CONFIDENCE_Z_SCORE = WEIGHT_TREND_PARAMETER_MANIFEST.confidence.zScore;
const DEFAULT_MEASUREMENT_STD_KG = WEIGHT_TREND_PARAMETER_MANIFEST.measurement.defaultStdKg;
const MIN_MEASUREMENT_STD_KG = WEIGHT_TREND_PARAMETER_MANIFEST.measurement.minimumStdKg;
const MAX_MEASUREMENT_STD_KG = WEIGHT_TREND_PARAMETER_MANIFEST.measurement.maximumStdKg;
const MEASUREMENT_NOISE_SHRINKAGE_POINTS = WEIGHT_TREND_PARAMETER_MANIFEST.measurement.shrinkagePoints;
const INITIAL_RATE_STD_KG_PER_DAY = WEIGHT_TREND_PARAMETER_MANIFEST.filter.initialRateStdKgPerDay;
const RATE_PROCESS_STD_KG_PER_DAY_SQRT_DAY = WEIGHT_TREND_PARAMETER_MANIFEST.filter.rateProcessStdKgPerDaySqrtDay;
const MIN_VARIANCE = WEIGHT_TREND_PARAMETER_MANIFEST.filter.minimumVariance;
const RECENT_WINDOW_POINTS = WEIGHT_TREND_PARAMETER_MANIFEST.legacySummary.recentWindowPoints;
const LOW_VOLATILITY_STD_KG = WEIGHT_TREND_PARAMETER_MANIFEST.legacySummary.lowVolatilityStdKg;
const MEDIUM_VOLATILITY_STD_KG = WEIGHT_TREND_PARAMETER_MANIFEST.legacySummary.mediumVolatilityStdKg;
const STEADY_RATE_KG_PER_WEEK = WEIGHT_TREND_PARAMETER_MANIFEST.legacySummary.steadyRateKgPerWeek;
const MIN_RATE_RESIDUAL_STD_KG = WEIGHT_TREND_PARAMETER_MANIFEST.calibrationWindowAverageRate.minimumResidualStdKg;
const SUFFICIENT_EVIDENCE_POINTS = WEIGHT_TREND_PARAMETER_MANIFEST.currentRate.sufficientEvidencePoints;
const SUFFICIENT_EVIDENCE_SPAN_DAYS = WEIGHT_TREND_PARAMETER_MANIFEST.currentRate.sufficientEvidenceSpanDays;

export type WeightTrendObservation = {
    date: Date;
    weight: number;
};

export type WeightTrendOptions = {
    /** Ignore observations after this instant, allowing reproducible historical/as-of evaluation. */
    asOfDate?: Date;
    /**
     * Exact calendar bounds for calibration's average-pace estimand.
     * Omit this outside calibration; the result then exposes no window-average estimate.
     */
    calibrationWindow?: {
        startDate: Date;
        endDate: Date;
    };
};

export type VolatilityLevel = 'low' | 'medium' | 'high';
export type WeightTrendDirection = 'down' | 'steady' | 'up' | 'uncertain';
export type WeightTrendEvidenceStatus = 'insufficient' | 'limited' | 'sufficient';
export type WeightTrendRateStatus = 'insufficient' | 'limited' | 'uncertain' | 'confident';

export type WeightTrendPoint = WeightTrendObservation & {
    /** Filtered latent level in kilograms. Retained for the v1 backend contract. */
    trendWeight: number;
    /** Posterior level standard deviation in kilograms. Retained for the v1 backend contract. */
    trendStd: number;
    /** Lower 95% posterior bound for the latent level in kilograms. */
    lower95: number;
    /** Upper 95% posterior bound for the latent level in kilograms. */
    upper95: number;
    /** Filtered local rate state in kilograms per day. */
    trendRatePerDay: number;
    /** Posterior rate standard deviation in kilograms per day. */
    trendRateStdPerDay: number;
    /** Lower 95% posterior bound for rate in kilograms per day. */
    trendRateLower95PerDay: number;
    /** Upper 95% posterior bound for rate in kilograms per day. */
    trendRateUpper95PerDay: number;
    segmentId: number;
    isSegmentStart: boolean;
    /** Actual elapsed days from the preceding observation; zero for the first point. */
    gapDays: number;
    /** Robust observation weight in (0, 1], where smaller values indicate an outlier. */
    huberWeight: number;
};

export type WeightTrendSegment = {
    id: number;
    startIndex: number;
    endIndex: number;
    startDate: Date;
    endDate: Date;
    pointCount: number;
    spanDays: number;
    effectiveObservationCount: number;
    resetGapDays: number | null;
};

export type WeightTrendEvidence = {
    pointCount: number;
    spanDays: number;
    segmentCount: number;
    latestSegmentPointCount: number;
    latestSegmentSpanDays: number;
    effectiveObservationCount: number;
    status: WeightTrendEvidenceStatus;
};

export type WeightTrendRate = {
    estimateKgPerWeek: number;
    stdKgPerWeek: number;
    lower95KgPerWeek: number;
    upper95KgPerWeek: number;
    pointCount: number;
    spanDays: number;
    direction: WeightTrendDirection;
    status: WeightTrendRateStatus;
};

export type WeightTrendResult = {
    points: WeightTrendPoint[];
    /** Legacy endpoint-based rate over the latest 14 points, in kilograms per week. */
    weeklyRate: number;
    volatility: VolatilityLevel;
    /** Latest local Kalman velocity state and its posterior uncertainty. */
    currentRate: WeightTrendRate;
    /** Robust window-average pace insight and its regression uncertainty. */
    windowAverageRate: WeightTrendRate;
    /** Robustly estimated day-to-day measurement variability in kilograms. */
    measurementVariabilityKg: number;
    evidence: WeightTrendEvidence;
    segments: WeightTrendSegment[];
    asOfDate: Date | null;
    params: {
        /** Latest rate state, retained under the v1 diagnostic name. */
        driftPerDay: number;
        /** Rate random-walk variance added per elapsed day. */
        processVariance: number;
        measurementVariance: number;
        huberK: number;
        segmentResetDays: number;
    };
};

export type WeightTrendSummaryInput = {
    date: Date;
    trendWeight: number;
    trendStd: number;
};

export type WeightTrendSummary = {
    weeklyRate: number;
    volatility: VolatilityLevel;
};

type Covariance = {
    level: number;
    levelRate: number;
    rate: number;
};

type FilterState = {
    level: number;
    rate: number;
    covariance: Covariance;
};

type InternalFilterPoint = WeightTrendPoint & {
    innovationKg: number;
    innovationStdKg: number;
};

type FilterPass = {
    points: InternalFilterPoint[];
    segments: WeightTrendSegment[];
};

const RATE_PROCESS_VARIANCE_PER_DAY = RATE_PROCESS_STD_KG_PER_DAY_SQRT_DAY ** 2;

/**
 * Estimate latent weight level and local rate with a forward-only robust Kalman filter.
 *
 * Inputs and outputs are kilograms. A gap greater than 14 days starts an independent
 * segment so stale momentum and confidence never bridge a long logging break.
 */
export function computeWeightTrend(
    observations: WeightTrendObservation[],
    options: WeightTrendOptions = {}
): WeightTrendResult {
    const sorted = normalizeObservations(observations, options.asOfDate);
    if (sorted.length === 0) {
        return emptyResult(
            validDate(options.asOfDate) ? new Date(options.asOfDate.getTime()) : null
        );
    }

    const preliminary = runFilterPass(sorted, DEFAULT_MEASUREMENT_STD_KG ** 2);
    const measurementVariabilityByPoint = estimateCausalMeasurementVariability(preliminary.points);
    const measurementVariabilityKg = measurementVariabilityByPoint[measurementVariabilityByPoint.length - 1]
        ?? DEFAULT_MEASUREMENT_STD_KG;
    const measurementVariance = measurementVariabilityKg ** 2;
    const finalPass = runFilterPass(
        sorted,
        measurementVariabilityByPoint.map((standardDeviation) => standardDeviation ** 2)
    );
    const points = finalPass.points.map(stripInternalPoint);
    const evidence = summarizeWeightTrendEvidence(points);
    const currentRate = summarizeCurrentRate(points, evidence);
    const windowAverageRate = summarizeWindowAverageRate(points, options.calibrationWindow);
    const latestPoint = points[points.length - 1];
    const latestSegmentPoints = points.filter((point) => point.segmentId === latestPoint.segmentId);

    return {
        points,
        weeklyRate: computeRecentWeeklyRate(latestSegmentPoints),
        volatility: classifyVolatility(points),
        currentRate,
        windowAverageRate,
        measurementVariabilityKg,
        evidence,
        segments: finalPass.segments,
        asOfDate: validDate(options.asOfDate)
            ? new Date(options.asOfDate.getTime())
            : new Date(latestPoint.date.getTime()),
        params: {
            driftPerDay: latestPoint.trendRatePerDay,
            processVariance: RATE_PROCESS_VARIANCE_PER_DAY,
            measurementVariance,
            huberK: WEIGHT_TREND_HUBER_K,
            segmentResetDays: WEIGHT_TREND_SEGMENT_RESET_DAYS
        }
    };
}

/** Preserve the v1 summary behavior for already-materialized level-only points. */
export function summarizeWeightTrend(points: WeightTrendSummaryInput[]): WeightTrendSummary {
    const normalized = points
        .filter((point) => validDate(point.date) && Number.isFinite(point.trendWeight) && Number.isFinite(point.trendStd))
        .slice()
        .sort((left, right) => left.date.getTime() - right.date.getTime())
        .map<WeightTrendPoint>((point) => ({
            date: point.date,
            weight: point.trendWeight,
            trendWeight: point.trendWeight,
            trendStd: Math.max(0, point.trendStd),
            lower95: point.trendWeight - CONFIDENCE_Z_SCORE * Math.max(0, point.trendStd),
            upper95: point.trendWeight + CONFIDENCE_Z_SCORE * Math.max(0, point.trendStd),
            trendRatePerDay: 0,
            trendRateStdPerDay: 0,
            trendRateLower95PerDay: 0,
            trendRateUpper95PerDay: 0,
            segmentId: 1,
            isSegmentStart: false,
            gapDays: 0,
            huberWeight: 1
        }));

    return {
        weeklyRate: computeRecentWeeklyRate(normalized),
        volatility: classifyVolatility(normalized)
    };
}

/** Build an evidence summary from modeled points, using only the latest segment for readiness. */
export function summarizeWeightTrendEvidence(points: WeightTrendPoint[]): WeightTrendEvidence {
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

    const ordered = points.slice().sort((left, right) => left.date.getTime() - right.date.getTime());
    const latestSegmentId = ordered[ordered.length - 1].segmentId;
    const latest = ordered.filter((point) => point.segmentId === latestSegmentId);
    const latestSpanDays = elapsedDays(latest[0].date, latest[latest.length - 1].date);
    const effectiveObservationCount = latest.reduce((sum, point) => sum + clamp(point.huberWeight, 0, 1), 0);
    const segmentCount = new Set(ordered.map((point) => point.segmentId)).size;

    return {
        pointCount: ordered.length,
        spanDays: elapsedDays(ordered[0].date, ordered[ordered.length - 1].date),
        segmentCount,
        latestSegmentPointCount: latest.length,
        latestSegmentSpanDays: latestSpanDays,
        effectiveObservationCount,
        status: classifyWeightTrendEvidence(latest.length, latestSpanDays, effectiveObservationCount)
    };
}

/** Grade the latest uninterrupted segment by observation count and elapsed days, not observation index spacing. */
export function classifyWeightTrendEvidence(
    pointCount: number,
    spanDays: number,
    _effectiveObservationCount = pointCount
): WeightTrendEvidenceStatus {
    if (pointCount < 2) return 'insufficient';
    if (pointCount < SUFFICIENT_EVIDENCE_POINTS || spanDays < SUFFICIENT_EVIDENCE_SPAN_DAYS) {
        return 'limited';
    }
    return 'sufficient';
}

/** Expose the shared sufficient-evidence decision without reimplementing its thresholds in callers. */
export function hasSufficientWeightTrendEvidence(evidence: WeightTrendEvidence): boolean {
    return evidence.status === 'sufficient';
}

/** Classify pace only after sufficient evidence, using the full weekly interval for direction or steady/uncertain status. */
export function classifyWeightTrendRate(
    lower95KgPerWeek: number,
    upper95KgPerWeek: number,
    evidenceStatus: WeightTrendEvidenceStatus
): { direction: WeightTrendDirection; status: WeightTrendRateStatus } {
    if (evidenceStatus === 'insufficient') return { direction: 'uncertain', status: 'insufficient' };
    if (evidenceStatus === 'limited') return { direction: 'uncertain', status: 'limited' };
    if (upper95KgPerWeek < 0) return { direction: 'down', status: 'confident' };
    if (lower95KgPerWeek > 0) return { direction: 'up', status: 'confident' };
    if (
        lower95KgPerWeek >= -STEADY_RATE_KG_PER_WEEK &&
        upper95KgPerWeek <= STEADY_RATE_KG_PER_WEEK
    ) {
        return { direction: 'steady', status: 'confident' };
    }
    return { direction: 'uncertain', status: 'uncertain' };
}

function emptyResult(asOfDate: Date | null): WeightTrendResult {
    const evidence = summarizeWeightTrendEvidence([]);
    const unavailableRate = buildUnavailableRate();
    return {
        points: [],
        weeklyRate: 0,
        volatility: 'low',
        currentRate: { ...unavailableRate },
        windowAverageRate: unavailableRate,
        measurementVariabilityKg: DEFAULT_MEASUREMENT_STD_KG,
        evidence,
        segments: [],
        asOfDate,
        params: {
            driftPerDay: 0,
            processVariance: RATE_PROCESS_VARIANCE_PER_DAY,
            measurementVariance: DEFAULT_MEASUREMENT_STD_KG ** 2,
            huberK: WEIGHT_TREND_HUBER_K,
            segmentResetDays: WEIGHT_TREND_SEGMENT_RESET_DAYS
        }
    };
}

function normalizeObservations(observations: WeightTrendObservation[], asOfDate: Date | undefined): WeightTrendObservation[] {
    const cutoffMs = validDate(asOfDate) ? asOfDate.getTime() : Number.POSITIVE_INFINITY;
    return observations
        .filter((observation) => (
            Number.isFinite(observation.weight) &&
            validDate(observation.date) &&
            observation.date.getTime() <= cutoffMs
        ))
        .map((observation) => ({ date: new Date(observation.date.getTime()), weight: observation.weight }))
        .sort((left, right) => left.date.getTime() - right.date.getTime());
}

function runFilterPass(observations: WeightTrendObservation[], measurementVariance: number | number[]): FilterPass {
    const points: InternalFilterPoint[] = [];
    let state: FilterState | null = null;
    let segmentId = 0;

    for (let index = 0; index < observations.length; index += 1) {
        const observation = observations[index];
        const currentMeasurementVariance = Array.isArray(measurementVariance)
            ? measurementVariance[index] ?? DEFAULT_MEASUREMENT_STD_KG ** 2
            : measurementVariance;
        const gapDays = index === 0 ? 0 : elapsedDays(observations[index - 1].date, observation.date);
        const isSegmentStart = index === 0 || gapDays > WEIGHT_TREND_SEGMENT_RESET_DAYS;

        if (isSegmentStart) {
            segmentId += 1;
            state = initializeState(observation.weight, currentMeasurementVariance);
        } else if (state) {
            state = predictState(state, gapDays);
        }

        if (!state) continue;
        let updated: {
            state: FilterState;
            innovationKg: number;
            innovationStdKg: number;
            huberWeight: number;
        };
        if (isSegmentStart) {
            updated = {
                state,
                innovationKg: 0,
                innovationStdKg: Math.sqrt(currentMeasurementVariance),
                huberWeight: 1
            };
        } else {
            updated = updateState(state, observation.weight, currentMeasurementVariance);
        }
        const currentState = updated.state;
        state = currentState;
        const levelStd = Math.sqrt(currentState.covariance.level);
        const rateStd = Math.sqrt(currentState.covariance.rate);
        points.push({
            date: observation.date,
            weight: observation.weight,
            trendWeight: currentState.level,
            trendStd: levelStd,
            lower95: currentState.level - CONFIDENCE_Z_SCORE * levelStd,
            upper95: currentState.level + CONFIDENCE_Z_SCORE * levelStd,
            trendRatePerDay: currentState.rate,
            trendRateStdPerDay: rateStd,
            trendRateLower95PerDay: currentState.rate - CONFIDENCE_Z_SCORE * rateStd,
            trendRateUpper95PerDay: currentState.rate + CONFIDENCE_Z_SCORE * rateStd,
            segmentId,
            isSegmentStart,
            gapDays,
            huberWeight: updated.huberWeight,
            innovationKg: updated.innovationKg,
            innovationStdKg: updated.innovationStdKg
        });

    }

    return { points, segments: buildSegments(points) };
}

function initializeState(weight: number, measurementVariance: number): FilterState {
    return {
        level: weight,
        rate: 0,
        covariance: {
            level: measurementVariance,
            levelRate: 0,
            rate: INITIAL_RATE_STD_KG_PER_DAY ** 2
        }
    };
}

function predictState(state: FilterState, deltaDays: number): FilterState {
    const dt = Math.max(0, deltaDays);
    const { level: p00, levelRate: p01, rate: p11 } = state.covariance;
    const q = RATE_PROCESS_VARIANCE_PER_DAY;
    const q00 = q * (dt ** 3) / 3;
    const q01 = q * (dt ** 2) / 2;
    const q11 = q * dt;

    return {
        level: state.level + state.rate * dt,
        rate: state.rate,
        covariance: stabilizeCovariance({
            level: p00 + 2 * dt * p01 + dt ** 2 * p11 + q00,
            levelRate: p01 + dt * p11 + q01,
            rate: p11 + q11
        })
    };
}

function updateState(
    predicted: FilterState,
    measurement: number,
    measurementVariance: number
): { state: FilterState; innovationKg: number; innovationStdKg: number; huberWeight: number } {
    const innovationKg = measurement - predicted.level;
    const baseInnovationVariance = predicted.covariance.level + measurementVariance;
    const innovationStdKg = Math.sqrt(Math.max(MIN_VARIANCE, baseInnovationVariance));
    const standardizedInnovation = Math.abs(innovationKg) / innovationStdKg;
    const huberWeight = standardizedInnovation <= WEIGHT_TREND_HUBER_K
        ? 1
        : WEIGHT_TREND_HUBER_K / standardizedInnovation;
    const effectiveMeasurementVariance = measurementVariance / Math.max(huberWeight, MIN_VARIANCE);
    const innovationVariance = predicted.covariance.level + effectiveMeasurementVariance;
    const levelGain = predicted.covariance.level / innovationVariance;
    const rateGain = predicted.covariance.levelRate / innovationVariance;
    const previousLevelVariance = predicted.covariance.level;
    const previousLevelRateCovariance = predicted.covariance.levelRate;

    return {
        state: {
            level: predicted.level + levelGain * innovationKg,
            rate: predicted.rate + rateGain * innovationKg,
            covariance: stabilizeCovariance({
                level: (1 - levelGain) * previousLevelVariance,
                levelRate: (1 - levelGain) * previousLevelRateCovariance,
                rate: predicted.covariance.rate - rateGain * previousLevelRateCovariance
            })
        },
        innovationKg,
        innovationStdKg,
        huberWeight
    };
}

function stabilizeCovariance(covariance: Covariance): Covariance {
    const level = Math.max(MIN_VARIANCE, covariance.level);
    const rate = Math.max(MIN_VARIANCE, covariance.rate);
    const maximumCrossMagnitude = Math.sqrt(level * rate);
    return {
        level,
        rate,
        levelRate: clamp(covariance.levelRate, -maximumCrossMagnitude, maximumCrossMagnitude)
    };
}

/** Estimate each prefix independently so later observations cannot rewrite historical states. */
function estimateCausalMeasurementVariability(points: InternalFilterPoint[]): number[] {
    const residuals: number[] = [];
    return points.map((point) => {
        if (point.isSegmentStart) residuals.length = 0;

        if (!point.isSegmentStart && point.innovationStdKg > 0) {
            const residual = point.innovationKg * DEFAULT_MEASUREMENT_STD_KG / point.innovationStdKg;
            if (Number.isFinite(residual)) residuals.push(residual);
        }

        const robustEstimate = robustStd(residuals);
        if (robustEstimate === null) return DEFAULT_MEASUREMENT_STD_KG;
        const boundedEstimate = clamp(robustEstimate, MIN_MEASUREMENT_STD_KG, MAX_MEASUREMENT_STD_KG);
        const shrinkage = residuals.length / (residuals.length + MEASUREMENT_NOISE_SHRINKAGE_POINTS);
        return clamp(
            DEFAULT_MEASUREMENT_STD_KG + shrinkage * (boundedEstimate - DEFAULT_MEASUREMENT_STD_KG),
            MIN_MEASUREMENT_STD_KG,
            MAX_MEASUREMENT_STD_KG
        );
    });
}

/** Package the latest Kalman velocity state without substituting a windowed estimator. */
function summarizeCurrentRate(points: WeightTrendPoint[], evidence: WeightTrendEvidence): WeightTrendRate {
    if (points.length === 0) return buildUnavailableRate();

    const latest = points[points.length - 1];
    const estimateKgPerWeek = latest.trendRatePerDay * 7;
    const stdKgPerWeek = latest.trendRateStdPerDay * 7;
    const lower95KgPerWeek = latest.trendRateLower95PerDay * 7;
    const upper95KgPerWeek = latest.trendRateUpper95PerDay * 7;
    const classification = evidence.latestSegmentSpanDays < SUFFICIENT_EVIDENCE_SPAN_DAYS
        ? { direction: 'uncertain' as const, status: 'insufficient' as const }
        : classifyWeightTrendRate(lower95KgPerWeek, upper95KgPerWeek, evidence.status);

    return {
        estimateKgPerWeek,
        stdKgPerWeek,
        lower95KgPerWeek,
        upper95KgPerWeek,
        pointCount: evidence.latestSegmentPointCount,
        spanDays: evidence.latestSegmentSpanDays,
        ...classification
    };
}

function summarizeWindowAverageRate(
    points: WeightTrendPoint[],
    window: WeightTrendOptions['calibrationWindow']
): WeightTrendRate {
    if (!window || !validDate(window.startDate) || !validDate(window.endDate)) {
        return buildUnavailableRate();
    }

    const startMs = window.startDate.getTime();
    const endMs = window.endDate.getTime();
    const requestedSpanDays = elapsedDays(window.startDate, window.endDate);
    if (
        startMs > endMs ||
        requestedSpanDays < WEIGHT_TREND_MIN_RATE_WINDOW_DAYS ||
        requestedSpanDays > WEIGHT_TREND_MAX_RATE_WINDOW_DAYS
    ) {
        return buildUnavailableRate();
    }

    const windowPoints = points.filter((point) => {
        const pointMs = point.date.getTime();
        return pointMs >= startMs && pointMs <= endMs;
    });
    const spanDays = windowPoints.length > 0
        ? elapsedDays(windowPoints[0].date, windowPoints[windowPoints.length - 1].date)
        : 0;
    const segmentIds = new Set(windowPoints.map((point) => point.segmentId));
    if (segmentIds.size > 1) {
        return buildUnavailableRate(windowPoints.length, spanDays);
    }

    const regression = estimateRobustSegmentRate(windowPoints);
    if (!regression) {
        return buildUnavailableRate(windowPoints.length, spanDays);
    }

    const effectiveObservationCount = windowPoints.reduce(
        (sum, point) => sum + clamp(point.huberWeight, 0, 1),
        0
    );
    const evidenceStatus = classifyWeightTrendEvidence(windowPoints.length, spanDays, effectiveObservationCount);
    const estimateKgPerWeek = regression.ratePerDay * 7;
    const stdKgPerWeek = regression.rateStdPerDay * 7;
    const lower95KgPerWeek = estimateKgPerWeek - CONFIDENCE_Z_SCORE * stdKgPerWeek;
    const upper95KgPerWeek = estimateKgPerWeek + CONFIDENCE_Z_SCORE * stdKgPerWeek;
    const classification = spanDays < SUFFICIENT_EVIDENCE_SPAN_DAYS
        ? { direction: 'uncertain' as const, status: 'insufficient' as const }
        : classifyWeightTrendRate(lower95KgPerWeek, upper95KgPerWeek, evidenceStatus);
    return {
        estimateKgPerWeek,
        stdKgPerWeek,
        lower95KgPerWeek,
        upper95KgPerWeek,
        pointCount: windowPoints.length,
        spanDays,
        ...classification
    };
}

function buildUnavailableRate(pointCount = 0, spanDays = 0): WeightTrendRate {
    return {
        estimateKgPerWeek: Number.NaN,
        stdKgPerWeek: Number.NaN,
        lower95KgPerWeek: Number.NaN,
        upper95KgPerWeek: Number.NaN,
        pointCount,
        spanDays,
        direction: 'uncertain',
        status: 'insufficient'
    };
}
type WeightedLineFit = {
    intercept: number;
    slope: number;
    weightedXSumOfSquares: number;
    effectivePointCount: number;
};

/**
 * Estimate calendar-window pace from every observation in the latest continuous segment.
 *
 * The local Kalman rate covariance answers how uncertain the instantaneous state is. This
 * regression answers the separate product question "what pace is supported across this
 * observed window?" Huber weights keep isolated scale spikes from dominating that pace.
 */
function estimateRobustSegmentRate(
    points: WeightTrendPoint[]
): { ratePerDay: number; rateStdPerDay: number } | null {
    if (points.length < 2) return null;
    const startMs = points[0].date.getTime();
    const xValues = points.map((point) => (point.date.getTime() - startMs) / MS_PER_DAY);
    const yValues = points.map((point) => point.weight);
    let weights = points.map(() => 1);
    let fit = fitWeightedLine(xValues, yValues, weights);
    if (!fit) return null;

    for (let iteration = 0; iteration < 3; iteration += 1) {
        const currentFit = fit;
        const residuals = yValues.map((value, index) => (
            value - (currentFit.intercept + currentFit.slope * xValues[index])
        ));
        const residualStd = robustStd(residuals);
        if (residualStd === null || residualStd <= MIN_RATE_RESIDUAL_STD_KG) break;
        weights = residuals.map((residual) => {
            const standardized = Math.abs(residual) / residualStd;
            return standardized <= WEIGHT_TREND_HUBER_K ? 1 : WEIGHT_TREND_HUBER_K / standardized;
        });
        const nextFit = fitWeightedLine(xValues, yValues, weights);
        if (!nextFit) break;
        fit = nextFit;
    }

    const finalFit = fit;
    const finalResiduals = yValues.map((value, index) => (
        value - (finalFit.intercept + finalFit.slope * xValues[index])
    ));
    const residualStd = Math.max(MIN_RATE_RESIDUAL_STD_KG, robustStd(finalResiduals) ?? 0);
    // A small default-noise contribution protects very sparse perfect-fit histories, but
    // decays quickly enough that a clean two-week series can support a useful pace interval.
    const sparseHistoryStd = DEFAULT_MEASUREMENT_STD_KG / Math.max(1, finalFit.effectivePointCount);
    const uncertaintyScale = Math.hypot(residualStd, sparseHistoryStd);
    const degreesOfFreedom = Math.max(1, finalFit.effectivePointCount - 2);
    const smallSampleAdjustment = Math.sqrt(finalFit.effectivePointCount / degreesOfFreedom);
    const rateStdPerDay = uncertaintyScale /
        Math.sqrt(Math.max(MIN_VARIANCE, finalFit.weightedXSumOfSquares)) *
        smallSampleAdjustment;

    return {
        ratePerDay: finalFit.slope,
        rateStdPerDay: Math.max(Math.sqrt(MIN_VARIANCE), rateStdPerDay)
    };
}

function fitWeightedLine(xValues: number[], yValues: number[], weights: number[]): WeightedLineFit | null {
    if (xValues.length !== yValues.length || xValues.length !== weights.length || xValues.length < 2) return null;
    let weightSum = 0;
    let weightedXSum = 0;
    let weightedYSum = 0;
    for (let index = 0; index < xValues.length; index += 1) {
        const weight = Number.isFinite(weights[index]) && weights[index] > 0 ? weights[index] : 0;
        weightSum += weight;
        weightedXSum += weight * xValues[index];
        weightedYSum += weight * yValues[index];
    }
    if (weightSum <= 0) return null;

    const xMean = weightedXSum / weightSum;
    const yMean = weightedYSum / weightSum;
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < xValues.length; index += 1) {
        const weight = Number.isFinite(weights[index]) && weights[index] > 0 ? weights[index] : 0;
        const centeredX = xValues[index] - xMean;
        numerator += weight * centeredX * (yValues[index] - yMean);
        denominator += weight * centeredX ** 2;
    }
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= MIN_VARIANCE) return null;
    const slope = numerator / denominator;
    if (!Number.isFinite(slope)) return null;
    return {
        intercept: yMean - slope * xMean,
        slope,
        weightedXSumOfSquares: denominator,
        effectivePointCount: weightSum
    };
}

function buildSegments(points: InternalFilterPoint[]): WeightTrendSegment[] {
    const segments: WeightTrendSegment[] = [];
    for (const point of points) {
        const existing = segments[segments.length - 1];
        if (!existing || existing.id !== point.segmentId) {
            segments.push({
                id: point.segmentId,
                startIndex: segments.length === 0 ? 0 : existing.endIndex + 1,
                endIndex: segments.length === 0 ? 0 : existing.endIndex + 1,
                startDate: point.date,
                endDate: point.date,
                pointCount: 1,
                spanDays: 0,
                effectiveObservationCount: point.huberWeight,
                resetGapDays: point.segmentId === 1 ? null : point.gapDays
            });
            continue;
        }
        existing.endIndex += 1;
        existing.endDate = point.date;
        existing.pointCount += 1;
        existing.spanDays = elapsedDays(existing.startDate, point.date);
        existing.effectiveObservationCount += point.huberWeight;
    }
    return segments;
}

function stripInternalPoint(point: InternalFilterPoint): WeightTrendPoint {
    const { innovationKg: _innovationKg, innovationStdKg: _innovationStdKg, ...publicPoint } = point;
    return publicPoint;
}

function computeRecentWeeklyRate(points: Array<Pick<WeightTrendPoint, 'date' | 'trendWeight'>>): number {
    if (points.length < 2) return 0;
    const start = points[Math.max(0, points.length - RECENT_WINDOW_POINTS)];
    const end = points[points.length - 1];
    const deltaDays = Math.max(1, elapsedDays(start.date, end.date));
    const rate = ((end.trendWeight - start.trendWeight) / deltaDays) * 7;
    return Number.isFinite(rate) ? rate : 0;
}

function classifyVolatility(points: Array<Pick<WeightTrendPoint, 'trendStd'>>): VolatilityLevel {
    const recentStd = points.slice(-RECENT_WINDOW_POINTS).map((point) => point.trendStd);
    const medianStd = median(recentStd) ?? 0;
    if (medianStd <= LOW_VOLATILITY_STD_KG) return 'low';
    if (medianStd <= MEDIUM_VOLATILITY_STD_KG) return 'medium';
    return 'high';
}

function elapsedDays(start: Date, end: Date): number {
    const value = (end.getTime() - start.getTime()) / MS_PER_DAY;
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function robustStd(values: number[]): number | null {
    const finite = values.filter(Number.isFinite);
    if (finite.length < 2) return null;
    const center = median(finite);
    if (center === null) return null;
    const mad = median(finite.map((value) => Math.abs(value - center)));
    return mad === null ? null : 1.4826 * mad;
}

function median(values: number[]): number | null {
    const finite = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
    if (finite.length === 0) return null;
    const middle = Math.floor(finite.length / 2);
    return finite.length % 2 === 1 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function validDate(value: Date | undefined): value is Date {
    return value instanceof Date && Number.isFinite(value.getTime());
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
}
