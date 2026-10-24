/** @file Completed-day calorie comparisons from saved historical plans rather than current profile estimates. */

import type { DailyCaloriePlan, FoodLogDay } from '@prisma/client';
import type { MutationDatabase } from './clientOperations';
import { observeCurrentCaloriePlan } from './dailyCaloriePlans';
import { localDateInTimeZone } from '../../../shared/caloriePolicy';

export type FoodDayCalorieComparison = {
  consumed_kcal: number;
  target_kcal: number;
  maintenance_kcal: number;
  captured_at: string;
};

/** Read frozen comparisons or retained daily observations, never today's settings for a past date. */
export async function readFoodDayComparison(db: MutationDatabase, day: FoodLogDay, now = new Date()): Promise<FoodDayCalorieComparison | null> {
  if (day.status === 'PAUSED') return null;
  let comparison = foodDayCalorieComparison(day, 0);
  if (day.status !== 'COMPLETE' && !day.comparison_captured_at) {
    const user = await db.user.findUnique({ where: { id: day.user_id }, select: { timezone: true } });
    const observed = await db.dailyCaloriePlan.findUnique({
      where: { user_id_local_date: { user_id: day.user_id, local_date: day.local_date } }
    });
    comparison = observedFoodDayCalorieComparison(observed, day.local_date, user?.timezone, 0, now);
  }
  if (!comparison) return null;
  const entries = await db.foodLog.findMany({
    where: { user_id: day.user_id, local_date: day.local_date },
    select: { calories: true }
  });
  const consumed = entries.reduce((total, entry) =>
    total + (Number.isSafeInteger(entry.calories) && entry.calories >= 0 ? entry.calories : NaN), 0);
  return foodDayCalorieComparison({
    comparison_target_kcal: comparison.target_kcal,
    comparison_maintenance_kcal: comparison.maintenance_kcal,
    comparison_captured_at: new Date(comparison.captured_at)
  }, consumed);
}

/** An unfinished day uses the same trustworthy observation that completion would freeze. */
export function observedFoodDayCalorieComparison(
  observed: Pick<DailyCaloriePlan, 'local_date' | 'timezone' | 'timezone_conflict' | 'observed_at' | 'target_kcal' | 'maintenance_kcal'> | null | undefined,
  localDate: Date,
  timezone: string | undefined,
  consumed: number,
  now: Date
): FoodDayCalorieComparison | null {
  const date = localDate.toISOString().slice(0, 10);
  const today = timezone && localDateInTimeZone(now, timezone);
  if (!observed || !today || date > today || observed.timezone_conflict || observed.timezone !== timezone ||
      observed.local_date.getTime() !== localDate.getTime() || observed.observed_at > now ||
      localDateInTimeZone(observed.observed_at, observed.timezone) !== date) return null;
  return foodDayCalorieComparison({
    comparison_target_kcal: observed.target_kcal,
    comparison_maintenance_kcal: observed.maintenance_kcal,
    comparison_captured_at: observed.observed_at
  }, consumed);
}

/** Caller holds the account guard before locking/upserting the day, through commit. */
export async function captureFoodDayComparison(db: MutationDatabase, day: FoodLogDay, now: Date): Promise<FoodLogDay> {
  if (day.status !== 'COMPLETE' || day.comparison_captured_at) return day;
  const user = await db.user.findUnique({ where: { id: day.user_id }, select: { timezone: true } });
  const today = user && localDateInTimeZone(now, user.timezone);
  const date = day.local_date.toISOString().slice(0, 10);
  if (!user || !today || date > today) return day;
  if (date === today) await observeCurrentCaloriePlan(db, day.user_id, now);
  const observed = await db.dailyCaloriePlan.findUnique({
    where: { user_id_local_date: { user_id: day.user_id, local_date: day.local_date } }
  });
  const comparison = observedFoodDayCalorieComparison(observed, day.local_date, user.timezone, 0, now);
  if (observed && !observed.consumed_at) {
    await db.dailyCaloriePlan.update({ where: { id: observed.id }, data: { consumed_at: now } });
  }
  // Capture unavailable too: later settings changes must not manufacture a plan for this completion.
  return db.foodLogDay.update({ where: { id: day.id }, data: {
    comparison_captured_at: now,
    comparison_target_kcal: comparison?.target_kcal ?? null,
    comparison_maintenance_kcal: comparison?.maintenance_kcal ?? null
  } });
}

/** Build a saved comparison only from valid captured plan values and nonnegative intake; otherwise return null. */
export function foodDayCalorieComparison(day: {
  comparison_target_kcal?: number | null;
  comparison_maintenance_kcal?: number | null;
  comparison_captured_at?: Date | null;
}, consumed: number): FoodDayCalorieComparison | null {
  const target = day.comparison_target_kcal;
  const maintenance = day.comparison_maintenance_kcal;
  const captured = day.comparison_captured_at;
  if (typeof target !== 'number' || !Number.isSafeInteger(target) || target <= 0 ||
      typeof maintenance !== 'number' || !Number.isSafeInteger(maintenance) || maintenance <= 0 ||
      !Number.isSafeInteger(consumed) || consumed < 0 ||
      !(captured instanceof Date) || !Number.isFinite(captured.getTime())) return null;
  return { consumed_kcal: consumed, target_kcal: target, maintenance_kcal: maintenance, captured_at: captured.toISOString() };
}
