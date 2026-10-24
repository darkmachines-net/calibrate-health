/** @file meal Period: Parse and validate a meal period identifier coming from API requests. */

import { MealPeriod } from '@prisma/client';

/**
 * Meal period parsing helpers for API payloads.
 */
const MEAL_PERIOD_VALUES = new Set<string>(Object.values(MealPeriod));

/**
 * Parse and validate a meal period identifier coming from API requests.
 *
 * `FoodLog.meal_period` is stored as a Prisma/Postgres enum. We accept only the
 * canonical enum identifiers so data stays consistent and the UI doesn't need
 * to alias/guess.
 */
export function parseMealPeriod(value: unknown): MealPeriod | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!MEAL_PERIOD_VALUES.has(trimmed)) {
    return null;
  }
  return trimmed as MealPeriod;
}
