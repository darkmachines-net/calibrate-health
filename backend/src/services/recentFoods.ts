/** @file Account-scoped reusable food suggestions ranked and deduplicated from immutable log history. */

import type { FoodLog, MealPeriod, Prisma } from '@prisma/client';
import prisma from '../config/database';

const RECENT_FOOD_LOOKBACK_LIMIT = 200;

export const RECENT_FOOD_DEFAULT_LIMIT = 12;
export const RECENT_FOOD_MAX_LIMIT = 40;

export type RecentFoodSuggestion = {
  id: string;
  name: string;
  meal_period: MealPeriod;
  calories: number;
  my_food_id: number | null;
  servings_consumed: number | null;
  serving_size_quantity_snapshot: number | null;
  serving_unit_label_snapshot: string | null;
  calories_per_serving_snapshot: number | null;
  external_source: string | null;
  external_id: string | null;
  brand_snapshot: string | null;
  locale_snapshot: string | null;
  barcode_snapshot: string | null;
  measure_label_snapshot: string | null;
  grams_per_measure_snapshot: number | null;
  measure_quantity_snapshot: number | null;
  grams_total_snapshot: number | null;
  last_logged_at: Date;
  times_logged: number;
};

type RecentFoodDatabase = Prisma.TransactionClient | typeof prisma;

type RankedRecentFoodSuggestion = {
  suggestion: RecentFoodSuggestion;
  recencyIndex: number;
  selectedMealTimesLogged: number;
  lastSelectedMealLogAt: Date | null;
};

/** Build a stable key so repeated logs collapse into one reusable suggestion. */
export const getRecentFoodKey = (log: FoodLog): string => {
  if (typeof log.my_food_id === 'number') return `my-food:${log.my_food_id}`;
  if (log.external_source && log.external_id) {
    return [
      'external',
      log.external_source,
      log.external_id,
      log.measure_label_snapshot ?? '',
      log.grams_per_measure_snapshot ?? ''
    ].join(':');
  }
  return [
    'manual',
    String(log.name ?? '').trim().toLowerCase(),
    log.serving_size_quantity_snapshot ?? '',
    String(log.serving_unit_label_snapshot ?? '').trim().toLowerCase(),
    log.calories_per_serving_snapshot ?? log.calories ?? ''
  ].join(':');
};

const buildSuggestion = (log: FoodLog, key: string): RecentFoodSuggestion => ({
  id: key,
  name: log.name,
  meal_period: log.meal_period,
  calories: log.calories,
  my_food_id: log.my_food_id ?? null,
  servings_consumed: log.servings_consumed ?? null,
  serving_size_quantity_snapshot: log.serving_size_quantity_snapshot ?? null,
  serving_unit_label_snapshot: log.serving_unit_label_snapshot ?? null,
  calories_per_serving_snapshot: log.calories_per_serving_snapshot ?? null,
  external_source: log.external_source ?? null,
  external_id: log.external_id ?? null,
  brand_snapshot: log.brand_snapshot ?? null,
  locale_snapshot: log.locale_snapshot ?? null,
  barcode_snapshot: log.barcode_snapshot ?? null,
  measure_label_snapshot: log.measure_label_snapshot ?? null,
  grams_per_measure_snapshot: log.grams_per_measure_snapshot ?? null,
  measure_quantity_snapshot: log.measure_quantity_snapshot ?? null,
  grams_total_snapshot: log.grams_total_snapshot ?? null,
  last_logged_at: log.created_at,
  times_logged: 1
});

/** Return a bounded, deduplicated recent-food list, biased toward the selected meal when provided. */
export async function getRecentFoodSuggestions(options: {
  userId: number;
  limit: number;
  query?: string;
  mealPeriod?: MealPeriod;
  database?: RecentFoodDatabase;
}): Promise<RecentFoodSuggestion[]> {
  const database = options.database ?? prisma;
  const limit = Math.min(Math.max(options.limit, 1), RECENT_FOOD_MAX_LIMIT);
  const query = options.query?.trim().toLowerCase() ?? '';
  const logs = await database.foodLog.findMany({
    where: { user_id: options.userId },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: RECENT_FOOD_LOOKBACK_LIMIT
  });

  const byKey = new Map<string, RankedRecentFoodSuggestion>();
  for (const log of logs) {
    if (query && !String(log.name ?? '').toLowerCase().includes(query)) continue;
    const key = getRecentFoodKey(log);
    const existing = byKey.get(key);
    if (existing) {
      existing.suggestion.times_logged += 1;
      if (log.meal_period === options.mealPeriod) {
        existing.selectedMealTimesLogged += 1;
        existing.lastSelectedMealLogAt ??= log.created_at;
      }
      continue;
    }
    byKey.set(key, {
      suggestion: buildSuggestion(log, key),
      recencyIndex: byKey.size,
      selectedMealTimesLogged: log.meal_period === options.mealPeriod ? 1 : 0,
      lastSelectedMealLogAt: log.meal_period === options.mealPeriod ? log.created_at : null
    });
  }

  const ranked = Array.from(byKey.values());
  if (options.mealPeriod) {
    ranked.sort((left, right) => {
      if (left.selectedMealTimesLogged !== right.selectedMealTimesLogged) {
        return right.selectedMealTimesLogged - left.selectedMealTimesLogged;
      }
      const selectedMealRecency = (right.lastSelectedMealLogAt?.getTime() ?? 0)
        - (left.lastSelectedMealLogAt?.getTime() ?? 0);
      if (selectedMealRecency !== 0) return selectedMealRecency;
      return left.recencyIndex - right.recencyIndex;
    });
  }

  return ranked.slice(0, limit).map(({ suggestion }) => suggestion);
}
