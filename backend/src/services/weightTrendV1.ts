/** @file weight Trend V1: Estimate latent "true weight" from noisy daily weigh-ins with a scalar Kalman filter. */

import { MS_PER_DAY } from '../utils/date';

const TREND_CONFIDENCE_Z_SCORE = 1.96; // 95% confidence interval for latent true-weight estimate.
const EWMA_TIME_CONSTANT_DAYS = 7; // Baseline smoother horizon used for robust residual estimation.
const RECENT_WINDOW_POINTS = 14; // Recent window for user-facing weekly-rate and volatility summaries.
const DRIFT_RECENCY_HALF_LIFE_DAYS = 30; // Recency horizon for drift: older history decays by 50% every 30 days.
const MIN_POSTERIOR_VARIANCE = 1e-8;
const MAX_PROCESS_TO_MEASUREMENT_VARIANCE_RATIO = 0.35; // Keep the trend from overfitting day-to-day scale noise.
const MAX_PREDICTION_GAP_DAYS = 14; // Cap uncertainty/mean propagation across sparse logging gaps.

type ModelDefaults = {
  measurementStd: number;
  processStd: number;
  minMeasurementStd: number;
  maxMeasurementStd: number;
  minProcessStd: number;
  maxProcessStd: number;
  lowVolatilityStdThreshold: number;
  mediumVolatilityStdThreshold: number;
};

const MODEL_DEFAULTS: ModelDefaults = {
  measurementStd: 0.9,
  processStd: 0.1,
  minMeasurementStd: 0.25,
  maxMeasurementStd: 3.5,
  minProcessStd: 0.02,
  maxProcessStd: 0.6,
  lowVolatilityStdThreshold: 0.5,
  mediumVolatilityStdThreshold: 1.2
};

export type WeightTrendObservation = {
  date: Date;
  weight: number;
};

type VolatilityLevel = 'low' | 'medium' | 'high';

type WeightTrendPoint = WeightTrendObservation & {
  trendWeight: number;
  trendStd: number;
  lower95: number;
  upper95: number;
};

export type WeightTrendResult = {
  points: WeightTrendPoint[];
  weeklyRate: number;
  volatility: VolatilityLevel;
  params: {
    driftPerDay: number;
    processVariance: number;
    measurementVariance: number;
  };
};

/**
 * Estimate latent "true weight" from noisy daily weigh-ins with a scalar Kalman filter.
 *
 * All modeling is done in kilograms. Unit conversion belongs at API boundaries.
 *
 * - State model: x_t = x_{t-1} + drift * dt + process_noise
 * - Observation: z_t = x_t + measurement_noise
 */
export function computeWeightTrendV1(observations: WeightTrendObservation[]): WeightTrendResult {
  if (observations.length === 0) {
    return {
      points: [],
      weeklyRate: 0,
      volatility: 'low',
      params: {
        driftPerDay: 0,
        processVariance: MODEL_DEFAULTS.processStd ** 2,
        measurementVariance: MODEL_DEFAULTS.measurementStd ** 2
      }
    };
  }

  const sorted = observations
    .filter((observation) => Number.isFinite(observation.weight) && Number.isFinite(observation.date.getTime()))
    .slice()
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  if (sorted.length === 0) {
    return {
      points: [],
      weeklyRate: 0,
      volatility: 'low',
      params: {
        driftPerDay: 0,
        processVariance: MODEL_DEFAULTS.processStd ** 2,
        measurementVariance: MODEL_DEFAULTS.measurementStd ** 2
      }
    };
  }

  const driftPerDay = estimateLinearDriftPerDay(sorted);
  const { processVariance, measurementVariance } = estimateVariances(sorted, driftPerDay);

  const points = runKalmanFilter(sorted, {
    driftPerDay,
    processVariance,
    measurementVariance
  });

  return {
    points,
    weeklyRate: computeRecentWeeklyRate(points),
    volatility: classifyVolatility(points),
    params: {
      driftPerDay,
      processVariance,
      measurementVariance
    }
  };
}

type KalmanParams = {
  driftPerDay: number;
  processVariance: number;
  measurementVariance: number;
};

function runKalmanFilter(observations: WeightTrendObservation[], params: KalmanParams): WeightTrendPoint[] {
  const points: WeightTrendPoint[] = [];

  let stateMean = observations[0].weight;
  let stateVariance = params.measurementVariance;

  for (let i = 0; i < observations.length; i += 1) {
    const observation = observations[i];
    const observedDeltaDays = i === 0 ? 0 : getDeltaDays(observations[i - 1].date, observation.date);
    const predictionDeltaDays = Math.min(observedDeltaDays, MAX_PREDICTION_GAP_DAYS);

    if (i > 0) {
      stateMean += params.driftPerDay * predictionDeltaDays;
      stateVariance += params.processVariance * predictionDeltaDays;
    }

    const predictedMeasurementVariance = stateVariance + params.measurementVariance;

    const innovation = observation.weight - stateMean;
    const innovationVariance = predictedMeasurementVariance;
    const kalmanGain = innovationVariance > 0 ? stateVariance / innovationVariance : 0;

    stateMean += kalmanGain * innovation;
    stateVariance = Math.max(MIN_POSTERIOR_VARIANCE, (1 - kalmanGain) * stateVariance);

    const trendStd = Math.sqrt(stateVariance);
    points.push({
      date: observation.date,
      weight: observation.weight,
      trendWeight: stateMean,
      trendStd,
      lower95: stateMean - TREND_CONFIDENCE_Z_SCORE * trendStd,
      upper95: stateMean + TREND_CONFIDENCE_Z_SCORE * trendStd
    });
  }

  return points;
}

function estimateVariances(
  observations: WeightTrendObservation[],
  driftPerDay: number
): { processVariance: number; measurementVariance: number } {
  const defaults = MODEL_DEFAULTS;
  if (observations.length < 3) {
    return {
      processVariance: defaults.processStd ** 2,
      measurementVariance: defaults.measurementStd ** 2
    };
  }

  const ewma = computeEwmaWeights(observations);
  const measurementResiduals = observations.map((observation, index) => observation.weight - ewma[index]);
  const processResidualsScaled: number[] = [];

  for (let i = 1; i < observations.length; i += 1) {
    const deltaDays = getDeltaDays(observations[i - 1].date, observations[i].date);
    // Use smoothed increments so process noise reflects underlying drift, not short-term water noise.
    const smoothedIncrement = ewma[i] - ewma[i - 1];
    const residual = smoothedIncrement - driftPerDay * deltaDays;
    processResidualsScaled.push(residual / Math.sqrt(deltaDays));
  }

  const measurementStdEstimate = robustStd(measurementResiduals);
  const processStdEstimate = robustStd(processResidualsScaled);

  const measurementStd = clamp(
    measurementStdEstimate ?? defaults.measurementStd,
    defaults.minMeasurementStd,
    defaults.maxMeasurementStd
  );
  const processStd = clamp(processStdEstimate ?? defaults.processStd, defaults.minProcessStd, defaults.maxProcessStd);
  const measurementVariance = measurementStd ** 2;
  const processVariance = Math.min(processStd ** 2, measurementVariance * MAX_PROCESS_TO_MEASUREMENT_VARIANCE_RATIO);

  return {
    processVariance,
    measurementVariance
  };
}

/**
 * Estimate slow daily drift with recency-weighted least-squares slope.
 *
 * We apply exponential decay so older logs still contribute but recent logs drive the current momentum estimate.
 */
function estimateLinearDriftPerDay(observations: WeightTrendObservation[]): number {
  if (observations.length < 2) return 0;

  const startMs = observations[0].date.getTime();
  const latestMs = observations[observations.length - 1].date.getTime();
  const xValues = observations.map((observation) => (observation.date.getTime() - startMs) / MS_PER_DAY);
  const yValues = observations.map((observation) => observation.weight);
  const weights = observations.map((observation) => {
    const ageDays = (latestMs - observation.date.getTime()) / MS_PER_DAY;
    return Math.exp((-Math.LN2 * ageDays) / DRIFT_RECENCY_HALF_LIFE_DAYS);
  });

  const weightedSlope = computeLeastSquaresSlope(xValues, yValues, weights);
  if (weightedSlope !== null) return weightedSlope;

  // Fall back to unweighted regression if recency weights become numerically degenerate.
  return computeLeastSquaresSlope(xValues, yValues) ?? 0;
}

function computeLeastSquaresSlope(xValues: number[], yValues: number[], weights?: number[]): number | null {
  if (xValues.length !== yValues.length || xValues.length === 0) return null;
  if (weights && weights.length !== xValues.length) return null;

  let weightSum = 0;
  let weightedXSum = 0;
  let weightedYSum = 0;
  for (let i = 0; i < xValues.length; i += 1) {
    const weight = weights?.[i] ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;

    weightSum += weight;
    weightedXSum += weight * xValues[i];
    weightedYSum += weight * yValues[i];
  }

  if (!Number.isFinite(weightSum) || weightSum <= 0) return null;

  const xMean = weightedXSum / weightSum;
  const yMean = weightedYSum / weightSum;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < xValues.length; i += 1) {
    const weight = weights?.[i] ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) continue;

    const xCentered = xValues[i] - xMean;
    numerator += weight * xCentered * (yValues[i] - yMean);
    denominator += weight * xCentered * xCentered;
  }

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;

  const slope = numerator / denominator;
  if (!Number.isFinite(slope)) return null;
  return slope;
}

function computeEwmaWeights(observations: WeightTrendObservation[]): number[] {
  const smoothed = [observations[0].weight];

  for (let i = 1; i < observations.length; i += 1) {
    const deltaDays = getDeltaDays(observations[i - 1].date, observations[i].date);
    const alpha = 1 - Math.exp(-deltaDays / EWMA_TIME_CONSTANT_DAYS);
    const previous = smoothed[i - 1];
    const next = previous + alpha * (observations[i].weight - previous);
    smoothed.push(next);
  }

  return smoothed;
}

function computeRecentWeeklyRate(points: WeightTrendPoint[]): number {
  if (points.length < 2) return 0;

  const windowStartIndex = Math.max(0, points.length - RECENT_WINDOW_POINTS);
  const start = points[windowStartIndex];
  const end = points[points.length - 1];
  const deltaDays = Math.max(1, (end.date.getTime() - start.date.getTime()) / MS_PER_DAY);
  const perDayRate = (end.trendWeight - start.trendWeight) / deltaDays;

  if (!Number.isFinite(perDayRate)) return 0;
  return perDayRate * 7;
}

function classifyVolatility(points: WeightTrendPoint[]): VolatilityLevel {
  if (points.length === 0) return 'low';

  const defaults = MODEL_DEFAULTS;
  const recent = points.slice(-RECENT_WINDOW_POINTS).map((point) => point.trendStd);
  const medianStd = median(recent) ?? 0;

  if (medianStd <= defaults.lowVolatilityStdThreshold) return 'low';
  if (medianStd <= defaults.mediumVolatilityStdThreshold) return 'medium';
  return 'high';
}

function getDeltaDays(previousDate: Date, nextDate: Date): number {
  const diffDays = (nextDate.getTime() - previousDate.getTime()) / MS_PER_DAY;
  if (!Number.isFinite(diffDays) || diffDays <= 0) return 1;
  return diffDays;
}

function robustStd(values: number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2) return null;

  const center = median(finite);
  if (center === null) return null;

  const absoluteDeviations = finite.map((value) => Math.abs(value - center));
  const mad = median(absoluteDeviations);
  if (mad === null) return null;

  return 1.4826 * mad;
}

function median(values: number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (finite.length === 0) return null;

  const middle = Math.floor(finite.length / 2);
  if (finite.length % 2 === 1) return finite[middle];
  return (finite[middle - 1] + finite[middle]) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
