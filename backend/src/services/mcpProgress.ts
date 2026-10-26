/** @file Read-only account-local food and weight detail windows with historical endpoints and separate actual-current plan context. */

import { Prisma, type MealPeriod } from '@prisma/client';
import prisma from '../config/database';
import {
  addUtcDays,
  isValidIanaTimeZone,
  MS_PER_DAY
} from '../utils/date';
import { resolveMcpEndDate } from './mcpProgressRange';
import { gramsToWeight, type WeightUnit } from '../utils/units';
import {
  buildStoredCaloriePlanningSnapshot,
  getStoredCaloriePlanningSnapshot,
  type StoredCaloriePlanningSnapshot
} from './caloriePlanning';
import type { MutationDatabase } from './clientOperations';
import {
  getEffectiveFoodDayRange,
  type FoodDaySource,
  type FoodDayStatus
} from './foodTracking';
import {
  getMaterializedTrendWindowFromLatestDate,
  WEIGHT_TREND_MODEL_VERSION
} from './materializedWeightTrend';
import {
  computeWeightTrend,
  type WeightTrendDirection,
  type WeightTrendEvidenceStatus,
  type WeightTrendRateStatus
} from './weightTrend';

const DEFAULT_FOOD_DAYS = 14;
const MIN_FOOD_DAYS = 1;
const MAX_FOOD_DAYS = 31;
const DEFAULT_WEIGHT_DAYS = 90;
const MIN_WEIGHT_DAYS = 7;
const MAX_WEIGHT_DAYS = 365;
const GRAMS_PER_KILOGRAM = 1_000;
const POUNDS_PER_KILOGRAM = 2.2046226218487757;
const TREND_CURRENT_MAX_AGE_DAYS = 7; // A reading from the last week is current evidence.
const TREND_STALE_MAX_AGE_DAYS = 14; // Evidence is stale through two weeks, then outdated.

type McpProgressDatabase = MutationDatabase;

type CalorieTargetContext = {
  as_of_date: string | null;
  plan_status: StoredCaloriePlanningSnapshot['evaluation']['status'] | 'unavailable';
  plan_reason_code: StoredCaloriePlanningSnapshot['evaluation']['reasonCode'];
  /** This remains the profile-estimated TDEE and is never inferred from logged intake or weight. */
  profile_estimated_tdee_kcal: number | null;
  base_daily_target_kcal: number | null;
  current_daily_target_kcal: number | null;
  target_adjustment_kcal: number | null;
  configured_daily_deficit_kcal: number | null;
};

type RecentFoodLogEntry = {
  meal_period: MealPeriod;
  name: string;
  calories_kcal: number;
  servings_consumed: number | null;
  serving_size_quantity: number | null;
  serving_unit: string | null;
};

type RecentFoodLogDay = {
  date: string;
  status: FoodDayStatus;
  source: FoodDaySource;
  is_representative: boolean;
  total_calories_kcal: number;
  entry_count: number;
  entries: RecentFoodLogEntry[];
};

export type RecentFoodLogsSnapshot = {
  as_of_date: string;
  timezone: string;
  requested_days: number;
  range: {
    start_date: string;
    end_date: string;
  };
  days: RecentFoodLogDay[];
  representative_summary: {
    complete_day_count: number;
    total_calories_kcal: number;
    average_daily_calories_kcal: number | null;
  };
  calorie_target_context: CalorieTargetContext;
  interpretation_notes: string[];
};

type WeightTrendFreshness = 'current' | 'stale' | 'outdated' | 'unavailable';
type WeightTrendSnapshotStatus = 'insufficient' | 'provisional' | 'sufficient' | 'stale';

export type WeightTrendSnapshot = {
  as_of_date: string;
  timezone: string;
  requested_days: number;
  range: {
    start_date: string;
    end_date: string;
  };
  weight_unit: 'kg' | 'lb';
  points: Array<{
    date: string;
    raw_weight: number;
    trend_weight: number | null;
    confidence_95: { lower: number; upper: number } | null;
    is_segment_start: boolean | null;
  }>;
  summary: {
    status: WeightTrendSnapshotStatus;
    evidence_status: WeightTrendEvidenceStatus;
    freshness: WeightTrendFreshness;
    model_version: number;
    confidence_level: 0.95;
    latest_observation_date: string | null;
    days_since_latest_observation: number | null;
    latest_trend: { weight: number; lower: number; upper: number } | null;
    weekly_rate: {
      estimate: number;
      standard_deviation: number;
      lower: number;
      upper: number;
      unit: 'kg/week' | 'lb/week';
      direction: WeightTrendDirection;
      status: Exclude<WeightTrendRateStatus, 'insufficient'>;
      point_count: number;
      span_days: number;
    } | null;
    measurement_variability: number | null;
    modeled_observation_count: number;
    returned_point_count: number;
    latest_segment_point_count: number;
    latest_segment_span_days: number;
    segment_count: number;
  };
  goal_context: {
    direction: 'weight_loss' | 'weight_gain' | 'maintenance';
    start_weight: number;
    target_weight: number;
    configured_daily_deficit_kcal: number;
    configured_target_date: string | null;
    projection_status: 'projected' | 'maintenance' | 'reached' | 'unavailable';
    projected_end_date: string | null;
  } | null;
  calorie_target_context: CalorieTargetContext;
  interpretation_notes: string[];
};

export type McpProgressOptions = {
  days?: number;
  end_date?: string;
  now?: Date;
  database?: McpProgressDatabase;
};

const dateKey = (date: Date): string => date.toISOString().slice(0, 10);

function clampDays(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function round(value: number, fractionDigits: number): number {
  const scale = 10 ** fractionDigits;
  return Math.round(value * scale) / scale;
}

function average(total: number, count: number): number | null {
  return count === 0 ? null : round(total / count, 1);
}

function kilogramsToPreferredUnit(kilograms: number, unit: WeightUnit, fractionDigits = 2): number {
  const value = unit === 'KG' ? kilograms : kilograms * POUNDS_PER_KILOGRAM;
  return round(value, fractionDigits);
}

function normalizeTimeZone(timezone: string): string {
  return isValidIanaTimeZone(timezone) ? timezone : 'UTC';
}

function goalDirection(dailyDeficit: number): 'weight_loss' | 'weight_gain' | 'maintenance' {
  if (dailyDeficit > 0) return 'weight_loss';
  if (dailyDeficit < 0) return 'weight_gain';
  return 'maintenance';
}

/** Serialize only current planning values; never use this context as a historical daily target. */
export function buildCalorieTargetContext(snapshot: StoredCaloriePlanningSnapshot | null): CalorieTargetContext {
  if (!snapshot) {
    return {
      as_of_date: null,
      plan_status: 'unavailable',
      plan_reason_code: null,
      profile_estimated_tdee_kcal: null,
      base_daily_target_kcal: null,
      current_daily_target_kcal: null,
      target_adjustment_kcal: null,
      configured_daily_deficit_kcal: null
    };
  }
  return {
    as_of_date: snapshot.localToday,
    plan_status: snapshot.evaluation.status,
    plan_reason_code: snapshot.evaluation.reasonCode,
    profile_estimated_tdee_kcal: snapshot.evaluation.tdee,
    base_daily_target_kcal: snapshot.evaluation.baseDailyCalorieTarget,
    current_daily_target_kcal: snapshot.evaluation.dailyCalorieTarget,
    target_adjustment_kcal: snapshot.evaluation.targetAdjustment,
    configured_daily_deficit_kcal: snapshot.goal?.daily_deficit ?? null
  };
}

function loadPlanningSnapshot(
  userId: number,
  now: Date,
  database: McpProgressDatabase
): Promise<StoredCaloriePlanningSnapshot | null> {
  return database === prisma
    ? getStoredCaloriePlanningSnapshot(userId, now)
    : buildStoredCaloriePlanningSnapshot(database, userId, now);
}

function supportsRepeatableRead(database: McpProgressDatabase): database is typeof prisma {
  return '$transaction' in database && typeof database.$transaction === 'function';
}

/**
 * Return recent food entries grouped by the account's local day.
 *
 * Optional end_date selects a historical window without changing the actual-current plan context.
 * Every day carries its canonical tracking resolution. Consumers must use only COMPLETE days
 * for progress averages; open, incomplete, paused, and pre-tracking days remain visible context.
 */
export async function getRecentFoodLogs(
  userId: number,
  options: McpProgressOptions = {}
): Promise<RecentFoodLogsSnapshot | null> {
  const now = options.now ?? new Date();
  const database = options.database ?? prisma;
  const requestedDays = clampDays(options.days, DEFAULT_FOOD_DAYS, MIN_FOOD_DAYS, MAX_FOOD_DAYS);
  const readSnapshot = async (snapshotDatabase: McpProgressDatabase) => {
    const user = await snapshotDatabase.user.findUnique({
      where: { id: userId },
      select: { timezone: true }
    });
    if (!user) return null;
    const timezone = normalizeTimeZone(user.timezone);
    const endDate = resolveMcpEndDate(options.end_date, timezone, now);
    const startDate = addUtcDays(endDate, -(requestedDays - 1));
    const [effectiveDays, logs, planningSnapshot] = await Promise.all([
      getEffectiveFoodDayRange(userId, startDate, endDate, now, snapshotDatabase),
      snapshotDatabase.foodLog.findMany({
      where: { user_id: userId, local_date: { gte: startDate, lte: endDate } },
      orderBy: [{ local_date: 'asc' }, { created_at: 'asc' }, { id: 'asc' }],
      select: {
        local_date: true,
        meal_period: true,
        name: true,
        calories: true,
        servings_consumed: true,
        serving_size_quantity_snapshot: true,
        serving_unit_label_snapshot: true
      }
      }),
      loadPlanningSnapshot(userId, now, snapshotDatabase)
    ]);
    return { timezone, startDate, endDate, effectiveDays, logs, planningSnapshot };
  };
  const snapshot = supportsRepeatableRead(database)
    ? await database.$transaction(
      (transaction) => readSnapshot(transaction),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    )
    : await readSnapshot(database);
  if (!snapshot) return null;
  const { timezone, startDate, endDate, effectiveDays, logs, planningSnapshot } = snapshot;

  const logsByDate = new Map<string, RecentFoodLogEntry[]>();
  for (const log of logs) {
    const key = dateKey(log.local_date);
    const entries = logsByDate.get(key) ?? [];
    entries.push({
      meal_period: log.meal_period,
      name: log.name,
      calories_kcal: log.calories,
      servings_consumed: log.servings_consumed,
      serving_size_quantity: log.serving_size_quantity_snapshot,
      serving_unit: log.serving_unit_label_snapshot
    });
    logsByDate.set(key, entries);
  }

  const days = (effectiveDays ?? []).map((day): RecentFoodLogDay => {
    const entries = logsByDate.get(day.date) ?? [];
    return {
      date: day.date,
      status: day.status,
      source: day.source,
      // The canonical food-day service guarantees this is true only for COMPLETE days.
      is_representative: day.status === 'COMPLETE' && day.is_representative,
      total_calories_kcal: entries.reduce((sum, entry) => sum + entry.calories_kcal, 0),
      entry_count: entries.length,
      entries
    };
  });
  const representativeDays = days.filter((day) => day.is_representative);
  const representativeCalories = representativeDays.reduce(
    (sum, day) => sum + day.total_calories_kcal,
    0
  );

  return {
    as_of_date: dateKey(endDate),
    timezone,
    requested_days: requestedDays,
    range: { start_date: dateKey(startDate), end_date: dateKey(endDate) },
    days,
    representative_summary: {
      complete_day_count: representativeDays.length,
      total_calories_kcal: representativeCalories,
      average_daily_calories_kcal: average(representativeCalories, representativeDays.length)
    },
    calorie_target_context: buildCalorieTargetContext(planningSnapshot),
    interpretation_notes: [
      'Only COMPLETE days are representative for calorie-intake progress analysis.',
      'The calorie target context is the actual current plan at its own as_of_date, not a historical target for every returned day.',
      'Profile-estimated TDEE is not inferred from food or weight observations.'
    ]
  };
}

function mapSnapshotStatus(
  evidenceStatus: WeightTrendEvidenceStatus,
  hasLatestPoint: boolean,
  freshness: WeightTrendFreshness
): WeightTrendSnapshotStatus {
  if (!hasLatestPoint || evidenceStatus === 'insufficient') return 'insufficient';
  if (freshness !== 'current') return 'stale';
  return evidenceStatus === 'limited' ? 'provisional' : 'sufficient';
}

function resolveFreshness(daysSinceLatest: number | null): WeightTrendFreshness {
  if (daysSinceLatest === null) return 'unavailable';
  if (daysSinceLatest <= TREND_CURRENT_MAX_AGE_DAYS) return 'current';
  if (daysSinceLatest <= TREND_STALE_MAX_AGE_DAYS) return 'stale';
  return 'outdated';
}

/**
 * Return raw weights and the canonical bounded trend model in the account's preferred unit.
 * end_date anchors historical evidence; current goal/plan context still uses actual now.
 * Later observations are excluded and long display ranges do not expand the model horizon.
 */
export async function getWeightTrend(
  userId: number,
  options: McpProgressOptions = {}
): Promise<WeightTrendSnapshot | null> {
  const now = options.now ?? new Date();
  const database = options.database ?? prisma;
  const requestedDays = clampDays(options.days, DEFAULT_WEIGHT_DAYS, MIN_WEIGHT_DAYS, MAX_WEIGHT_DAYS);
  const readSnapshot = async (snapshotDatabase: McpProgressDatabase) => {
    const user = await snapshotDatabase.user.findUnique({
      where: { id: userId },
      select: { timezone: true, weight_unit: true }
    });
    if (!user) return null;
    const timezone = normalizeTimeZone(user.timezone);
    const weightUnit: WeightUnit = user.weight_unit === 'LB' ? 'LB' : 'KG';
    const asOfDate = resolveMcpEndDate(options.end_date, timezone, now);
    const displayStartDate = addUtcDays(asOfDate, -(requestedDays - 1));
    const [latestMetric, planningSnapshot] = await Promise.all([
      snapshotDatabase.bodyMetric.findFirst({
      where: { user_id: userId, date: { lte: asOfDate } },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      select: { date: true }
      }),
      loadPlanningSnapshot(userId, now, snapshotDatabase)
    ]);
    const latestEligibleMetric = latestMetric && latestMetric.date <= asOfDate ? latestMetric : null;
    const trendWindow = latestEligibleMetric
      ? getMaterializedTrendWindowFromLatestDate(latestEligibleMetric.date)
      : null;
    const queryStartDate = trendWindow && trendWindow.modelStartDate < displayStartDate
      ? trendWindow.modelStartDate
      : displayStartDate;
    const queriedMetrics = await snapshotDatabase.bodyMetric.findMany({
      where: { user_id: userId, date: { gte: queryStartDate, lte: asOfDate } },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      select: { date: true, weight_grams: true }
    });
    return {
      timezone,
      weightUnit,
      asOfDate,
      displayStartDate,
      latestEligibleMetric,
      trendWindow,
      queriedMetrics,
      planningSnapshot
    };
  };
  const snapshot = supportsRepeatableRead(database)
    ? await database.$transaction(
      (transaction) => readSnapshot(transaction),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    )
    : await readSnapshot(database);
  if (!snapshot) return null;
  const {
    timezone,
    weightUnit,
    asOfDate,
    displayStartDate,
    latestEligibleMetric,
    trendWindow,
    queriedMetrics,
    planningSnapshot
  } = snapshot;
  // Preserve a defensive boundary for test doubles and legacy rows in addition to the DB predicate.
  const metrics = queriedMetrics.filter((metric) => metric.date <= asOfDate);
  const modelMetrics = trendWindow
    ? metrics.filter((metric) => metric.date >= trendWindow.modelStartDate)
    : [];
  const trendResult = computeWeightTrend(
    modelMetrics.map((metric) => ({
      date: metric.date,
      weight: metric.weight_grams / GRAMS_PER_KILOGRAM
    })),
    { asOfDate }
  );
  const trendPointsByDate = new Map(trendResult.points.map((point) => [point.date.getTime(), point]));
  const returnedMetrics = metrics.filter((metric) => metric.date >= displayStartDate);
  const points = returnedMetrics.map((metric) => {
    const modeledPoint = trendWindow && metric.date >= trendWindow.activeStartDate
      ? trendPointsByDate.get(metric.date.getTime()) ?? null
      : null;
    return {
      date: dateKey(metric.date),
      raw_weight: gramsToWeight(metric.weight_grams, weightUnit),
      trend_weight: modeledPoint
        ? kilogramsToPreferredUnit(modeledPoint.trendWeight, weightUnit)
        : null,
      confidence_95: modeledPoint
        ? {
            lower: kilogramsToPreferredUnit(modeledPoint.lower95, weightUnit),
            upper: kilogramsToPreferredUnit(modeledPoint.upper95, weightUnit)
          }
        : null,
      is_segment_start: modeledPoint ? modeledPoint.isSegmentStart : null
    };
  });

  const latestPoint = trendResult.points[trendResult.points.length - 1] ?? null;
  const latestObservationDate = latestPoint?.date ?? latestEligibleMetric?.date ?? null;
  const daysSinceLatest = latestObservationDate
    ? Math.max(0, Math.round((asOfDate.getTime() - latestObservationDate.getTime()) / MS_PER_DAY))
    : null;
  const freshness = resolveFreshness(daysSinceLatest);
  const hasCurrentRate = latestPoint !== null &&
    freshness !== 'outdated' &&
    trendResult.currentRate.status !== 'insufficient' &&
    Number.isFinite(trendResult.currentRate.estimateKgPerWeek) &&
    Number.isFinite(trendResult.currentRate.stdKgPerWeek) &&
    Number.isFinite(trendResult.currentRate.lower95KgPerWeek) &&
    Number.isFinite(trendResult.currentRate.upper95KgPerWeek);
  const rateStatus = trendResult.currentRate.status as Exclude<WeightTrendRateStatus, 'insufficient'>;
  const projection = planningSnapshot?.projection ?? null;
  const goal = planningSnapshot?.goal ?? null;

  return {
    as_of_date: dateKey(asOfDate),
    timezone,
    requested_days: requestedDays,
    range: { start_date: dateKey(displayStartDate), end_date: dateKey(asOfDate) },
    weight_unit: weightUnit === 'KG' ? 'kg' : 'lb',
    points,
    summary: {
      status: mapSnapshotStatus(trendResult.evidence.status, latestPoint !== null, freshness),
      evidence_status: trendResult.evidence.status,
      freshness,
      model_version: WEIGHT_TREND_MODEL_VERSION,
      confidence_level: 0.95,
      latest_observation_date: latestObservationDate ? dateKey(latestObservationDate) : null,
      days_since_latest_observation: daysSinceLatest,
      latest_trend: latestPoint
        ? {
            weight: kilogramsToPreferredUnit(latestPoint.trendWeight, weightUnit),
            lower: kilogramsToPreferredUnit(latestPoint.lower95, weightUnit),
            upper: kilogramsToPreferredUnit(latestPoint.upper95, weightUnit)
          }
        : null,
      weekly_rate: hasCurrentRate
        ? {
            estimate: kilogramsToPreferredUnit(trendResult.currentRate.estimateKgPerWeek, weightUnit, 3),
            standard_deviation: kilogramsToPreferredUnit(trendResult.currentRate.stdKgPerWeek, weightUnit, 3),
            lower: kilogramsToPreferredUnit(trendResult.currentRate.lower95KgPerWeek, weightUnit, 3),
            upper: kilogramsToPreferredUnit(trendResult.currentRate.upper95KgPerWeek, weightUnit, 3),
            unit: weightUnit === 'KG' ? 'kg/week' : 'lb/week',
            direction: trendResult.currentRate.direction,
            status: rateStatus,
            point_count: trendResult.currentRate.pointCount,
            span_days: trendResult.currentRate.spanDays
          }
        : null,
      measurement_variability: latestPoint
        ? kilogramsToPreferredUnit(trendResult.measurementVariabilityKg, weightUnit)
        : null,
      modeled_observation_count: trendResult.points.length,
      returned_point_count: points.length,
      latest_segment_point_count: trendResult.evidence.latestSegmentPointCount,
      latest_segment_span_days: trendResult.evidence.latestSegmentSpanDays,
      segment_count: trendResult.evidence.segmentCount
    },
    goal_context: goal
      ? {
          direction: goalDirection(goal.daily_deficit),
          start_weight: gramsToWeight(goal.start_weight_grams, weightUnit),
          target_weight: gramsToWeight(goal.target_weight_grams, weightUnit),
          configured_daily_deficit_kcal: goal.daily_deficit,
          configured_target_date: goal.target_date ? dateKey(goal.target_date) : null,
          projection_status: projection?.status ?? 'unavailable',
          projected_end_date: projection?.projectedEndDate ?? null
        }
      : null,
    calorie_target_context: buildCalorieTargetContext(planningSnapshot),
    interpretation_notes: [
      'Raw weights are measurements; trend and confidence fields are model estimates, not additional measurements.',
      'Trend freshness and pace are evaluated at the selected end date; goal and calorie context describe the actual current plan.',
      'A null weekly rate means the evidence is insufficient or too old for a current pace estimate.',
      'Short-term weight changes can reflect hydration and other normal variation.',
      'Profile-estimated TDEE remains separate from the observed weight trend and is not replaced by it.'
    ]
  };
}
