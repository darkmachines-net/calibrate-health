/** @file Read-only, scope-limited historical progress analysis using saved daily targets and canonical weight evidence. */

import { Prisma } from '@prisma/client';
import { MEAL_PERIODS } from '../../../shared/domain';
import { calculateCanonicalGoalProgress } from '../../../shared/goalProgress';
import prisma from '../config/database';
import type {
  ProgressComparisonSnapshot, ProgressExplorerSnapshot, ProgressFood, ProgressFoodDay, ProgressFoodGroup,
  ProgressGoal, ProgressHistory, ProgressPeriodSummary, ProgressRange, ProgressRangeInput, ProgressSections, ProgressWeight
} from '../mcp/progressTypes';
import { getSafeUtcTodayDateOnlyInTimeZone, MS_PER_DAY, parseLocalDateOnly } from '../utils/date';
import { gramsToWeight } from '../utils/units';
import { buildStoredCaloriePlanningSnapshot, type StoredCaloriePlanningSnapshot } from './caloriePlanning';
import type { MutationDatabase } from './clientOperations';
import { getEffectiveFoodDayRange } from './foodTracking';
import { buildCalorieTargetContext, getWeightTrend } from './mcpProgress';
import { resolveMcpProgressRange } from './mcpProgressRange';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const INTERPRETATION_NOTES = [
  'Current goal and calorie plan describe today, independently of the selected historical period.',
  'Only COMPLETE food days enter intake patterns. Missing or unfinished days are not zero intake.',
  'Historical target comparisons use saved daily evidence only; unavailable targets are never reconstructed.',
  'Weight change uses actual in-range observations; modeled pace describes the period end, not an average over the whole period.',
  'Trend estimates carry uncertainty and freshness. Descriptive patterns do not establish causes.',
  'Profile-estimated TDEE remains calories-out; observed intake, weight, or activity never replace it.'
];

export type McpAnalysisOptions = ProgressRangeInput & {
  sections: ProgressSections;
  now?: Date;
  database?: MutationDatabase;
};
export type McpComparisonOptions = Omit<McpAnalysisOptions, keyof ProgressRangeInput> & {
  first: Required<ProgressRangeInput>;
  second: Required<ProgressRangeInput>;
};

const dateKey = (date: Date): string => date.toISOString().slice(0, 10);
const round = (value: number): number => Math.round(value * 100) / 100;
const average = (total: number, count: number): number | null => count ? round(total / count) : null;
const difference = (first: number | null | undefined, second: number | null | undefined): number | null =>
  typeof first === 'number' && typeof second === 'number' ? round(second - first) : null;

/** Reuse a caller transaction; otherwise hold one consistent read snapshot for every returned section. */
function withSnapshot<T>(database: MutationDatabase, read: (tx: MutationDatabase) => Promise<T>): Promise<T> {
  if ('$transaction' in database) {
    return database.$transaction(tx => read(tx), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  return read(database);
}

/** Current goal progress deliberately uses the latest actual-current observation, never the historical chart endpoint. */
function currentGoal(snapshot: StoredCaloriePlanningSnapshot): ProgressGoal | null {
  const goal = snapshot.goal;
  if (!goal) return null;
  const unit = snapshot.user.weight_unit;
  const progress = calculateCanonicalGoalProgress({
    startWeightGrams: goal.start_weight_grams, targetWeightGrams: goal.target_weight_grams, dailyDeficit: goal.daily_deficit
  }, snapshot.latestWeightGrams);
  let direction: ProgressGoal['direction'] = 'maintenance';
  if (progress.mode === 'lose') direction = 'weight_loss';
  if (progress.mode === 'gain') direction = 'weight_gain';
  return {
    direction, start_weight: gramsToWeight(goal.start_weight_grams, unit), target_weight: gramsToWeight(goal.target_weight_grams, unit),
    current_weight: snapshot.latestWeightGrams === null ? null : gramsToWeight(snapshot.latestWeightGrams, unit),
    current_weight_date: snapshot.weightMetric ? dateKey(snapshot.weightMetric.date) : null,
    weight_unit: unit === 'LB' ? 'lb' : 'kg', progress_percent: progress.progressPercent,
    remaining_weight: gramsToWeight(progress.remainingWeightGrams, unit), configured_daily_deficit_kcal: goal.daily_deficit,
    projection_status: snapshot.projection?.status ?? 'unavailable', projected_end_date: snapshot.projection?.projectedEndDate ?? null
  };
}

/** Counts and sums remain available so adjacent historical windows can be combined without averaging averages. */
function group(key: string, days: ProgressFoodDay[], calories?: number): ProgressFoodGroup {
  const total = calories ?? days.reduce((sum, day) => sum + day.total_calories_kcal, 0);
  return { key, complete_day_count: days.length, total_calories_kcal: total, average_daily_calories_kcal: average(total, days.length) };
}

/** Aggregate sanitized calories using canonical completion and captured targets, without loading food names. */
async function readFood(userId: number, range: ProgressRange, now: Date, db: MutationDatabase): Promise<ProgressFood> {
  const start = parseLocalDateOnly(range.start_date);
  const end = parseLocalDateOnly(range.end_date);
  const [effectiveDays, logs] = await Promise.all([
    getEffectiveFoodDayRange(userId, start, end, now, db),
    db.foodLog.findMany({
      where: { user_id: userId, local_date: { gte: start, lte: end } },
      select: { local_date: true, meal_period: true, calories: true }
    })
  ]);
  const logsByDate = new Map<string, typeof logs>();
  for (const log of logs) {
    const key = dateKey(log.local_date);
    const entries = logsByDate.get(key) ?? [];
    entries.push(log);
    logsByDate.set(key, entries);
  }
  const days = (effectiveDays ?? []).map((day): ProgressFoodDay => {
    const entries = logsByDate.get(day.date) ?? [];
    return {
      date: day.date, status: day.status, source: day.source,
      is_representative: day.status === 'COMPLETE' && day.is_representative,
      total_calories_kcal: entries.reduce((sum, entry) => sum + entry.calories, 0), entry_count: entries.length,
      calorie_comparison: day.calorie_comparison ?? null
    };
  });
  const complete = days.filter(day => day.is_representative);
  const compared = complete.flatMap(day => day.calorie_comparison ? [day.calorie_comparison] : []);
  const consumed = compared.reduce((sum, day) => sum + day.consumed_kcal, 0);
  const target = compared.reduce((sum, day) => sum + day.target_kcal, 0);
  const total = complete.reduce((sum, day) => sum + day.total_calories_kcal, 0);
  const weekday = (day: ProgressFoodDay): number => parseLocalDateOnly(day.date).getUTCDay();
  const weekend = (day: ProgressFoodDay): boolean => weekday(day) === 0 || weekday(day) === 6;
  const completeDates = new Set(complete.map(day => day.date));
  return {
    days,
    summary: {
      complete_day_count: complete.length,
      open_day_count: days.filter(day => day.status === 'OPEN' && day.source !== 'BEFORE_TRACKING_START').length,
      incomplete_day_count: days.filter(day => day.status === 'INCOMPLETE').length,
      paused_day_count: days.filter(day => day.status === 'PAUSED').length,
      before_tracking_day_count: days.filter(day => day.source === 'BEFORE_TRACKING_START').length,
      total_calories_kcal: total, average_daily_calories_kcal: average(total, complete.length),
      compared_day_count: compared.length, compared_consumed_total_kcal: consumed, compared_target_total_kcal: target,
      average_captured_target_kcal: average(target, compared.length), average_target_difference_kcal: average(consumed - target, compared.length)
    },
    patterns: {
      weekdays: [1, 2, 3, 4, 5, 6, 0].map(index => group(WEEKDAYS[index], complete.filter(day => weekday(day) === index))),
      week_parts: [group('weekdays', complete.filter(day => !weekend(day))), group('weekends', complete.filter(weekend))],
      meal_periods: Object.values(MEAL_PERIODS).map(period => group(period, complete,
        logs.filter(log => completeDates.has(dateKey(log.local_date)) && log.meal_period === period)
          .reduce((sum, log) => sum + log.calories, 0)))
    }
  };
}

/** Reuse historical bounded-model evidence while restricting raw endpoints to the requested display dates. */
async function readWeight(userId: number, range: ProgressRange, now: Date, db: MutationDatabase): Promise<ProgressWeight | null> {
  const snapshot = await getWeightTrend(userId, { days: Math.max(7, range.day_count), end_date: range.end_date, now, database: db });
  if (!snapshot) return null;
  const points = snapshot.points.filter(point => point.date >= range.start_date);
  const first = points[0] ?? null;
  const last = points[points.length - 1] ?? null;
  return {
    weight_unit: snapshot.weight_unit, points,
    period_summary: {
      observation_count: points.length,
      first_observation: first ? { date: first.date, weight: first.raw_weight } : null,
      last_observation: last ? { date: last.date, weight: last.raw_weight } : null,
      observation_span_days: first && last ? Math.round((parseLocalDateOnly(last.date).getTime() - parseLocalDateOnly(first.date).getTime()) / MS_PER_DAY) : 0,
      raw_weight_change: first && last && first.date !== last.date ? round(last.raw_weight - first.raw_weight) : null
    },
    trend: { as_of_date: range.end_date, ...snapshot.summary }
  };
}

/** History bounds expose dates only, and never query a dataset outside the granted sections. */
async function readHistory(userId: number, today: Date, sections: ProgressSections, db: MutationDatabase) {
  const readFoodBound = async (order: 'asc' | 'desc'): Promise<string | null> => {
    const [log, day] = await Promise.all([
      db.foodLog.findFirst({ where: { user_id: userId, local_date: { lte: today } }, orderBy: { local_date: order }, select: { local_date: true } }),
      db.foodLogDay.findFirst({ where: { user_id: userId, local_date: { lte: today } }, orderBy: { local_date: order }, select: { local_date: true } })
    ]);
    const dates = [log?.local_date, day?.local_date].filter((date): date is Date => date instanceof Date).map(dateKey).sort();
    return (order === 'asc' ? dates[0] : dates[dates.length - 1]) ?? null;
  };
  const readWeightBound = async (order: 'asc' | 'desc'): Promise<string | null> => {
    const metric = await db.bodyMetric.findFirst({ where: { user_id: userId, date: { lte: today } }, orderBy: { date: order }, select: { date: true } });
    return metric ? dateKey(metric.date) : null;
  };
  const bounds = async (read: (order: 'asc' | 'desc') => Promise<string | null>): Promise<ProgressHistory> => {
    const [first_date, last_date] = await Promise.all([read('asc'), read('desc')]);
    return { first_date, last_date };
  };
  const [food, weight] = await Promise.all([sections.food ? bounds(readFoodBound) : null, sections.weight ? bounds(readWeightBound) : null]);
  return { food, weight };
}

/** Resolve only granted historical datasets on the caller's consistent snapshot. */
async function readPeriod(userId: number, range: ProgressRange, now: Date, sections: ProgressSections, db: MutationDatabase) {
  const [food, weight] = await Promise.all([
    sections.food ? readFood(userId, range, now, db) : null,
    sections.weight ? readWeight(userId, range, now, db) : null
  ]);
  return { range, food, weight };
}

/** Read the App's complete chart/analysis snapshot without names, identifiers, or mutations; unauthorized sections are null. */
export async function getProgressSummary(userId: number, options: McpAnalysisOptions): Promise<ProgressExplorerSnapshot | null> {
  const now = options.now ?? new Date();
  return withSnapshot(options.database ?? prisma, async db => {
    const planning = await buildStoredCaloriePlanningSnapshot(db, userId, now);
    if (!planning) return null;
    const timezone = planning.user.timezone;
    const today = getSafeUtcTodayDateOnlyInTimeZone(timezone, now);
    const range = resolveMcpProgressRange(options, timezone, now);
    const [period, history] = await Promise.all([
      readPeriod(userId, range, now, options.sections, db), readHistory(userId, today, options.sections, db)
    ]);
    return {
      schema_version: 1, as_of_date: dateKey(today), timezone, ...period, granted_sections: options.sections,
      available_history: history, current_goal: options.sections.weight ? currentGoal(planning) : null,
      current_calorie_plan: buildCalorieTargetContext(planning), interpretation_notes: INTERPRETATION_NOTES
    };
  });
}

/** Strip daily series from comparisons while retaining all additive counts, sums, patterns, and weight endpoint evidence. */
function compactPeriod(period: Awaited<ReturnType<typeof readPeriod>>): ProgressPeriodSummary {
  const food = period.food ? { summary: period.food.summary, patterns: period.food.patterns } : null;
  const weight = period.weight ? { weight_unit: period.weight.weight_unit, period_summary: period.weight.period_summary, trend: period.weight.trend } : null;
  return { range: period.range, food, weight };
}

/** Compare periods sequentially within one snapshot; differences are second minus first and preserve missing evidence. */
export async function compareProgressPeriods(userId: number, options: McpComparisonOptions): Promise<ProgressComparisonSnapshot | null> {
  const now = options.now ?? new Date();
  return withSnapshot(options.database ?? prisma, async db => {
    const planning = await buildStoredCaloriePlanningSnapshot(db, userId, now);
    if (!planning) return null;
    const timezone = planning.user.timezone;
    const firstRange = resolveMcpProgressRange(options.first, timezone, now);
    const secondRange = resolveMcpProgressRange(options.second, timezone, now);
    // Prisma transaction clients expose nested transactions, but the canonical weight reader cannot open two concurrently.
    const periods = [
      await readPeriod(userId, firstRange, now, options.sections, db),
      await readPeriod(userId, secondRange, now, options.sections, db)
    ];
    const [first, second] = periods.map(compactPeriod);
    return {
      schema_version: 1, as_of_date: dateKey(getSafeUtcTodayDateOnlyInTimeZone(timezone, now)), timezone,
      granted_sections: options.sections, current_goal: options.sections.weight ? currentGoal(planning) : null,
      current_calorie_plan: buildCalorieTargetContext(planning), first, second,
      differences: {
        average_daily_calories_kcal: difference(first.food?.summary.average_daily_calories_kcal, second.food?.summary.average_daily_calories_kcal),
        average_target_difference_kcal: difference(first.food?.summary.average_target_difference_kcal, second.food?.summary.average_target_difference_kcal),
        raw_weight_change: difference(first.weight?.period_summary.raw_weight_change, second.weight?.period_summary.raw_weight_change)
      },
      interpretation_notes: [...INTERPRETATION_NOTES, 'Differences are second period minus first. Periods may differ in length and completeness; compare the supplied denominators.']
    };
  });
}
