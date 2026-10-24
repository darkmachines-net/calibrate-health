/** @file dev Test Data Utils: Pure helpers for building deterministic dev seed data. */

import { FoodLogDayOrigin, FoodLogDayStatus, MealPeriod } from '@prisma/client';
import { formatDateToLocalDateString, normalizeToUtcDateOnly } from '../utils/date';

export const DEV_SEED_FOOD_HISTORY_DAYS = 28;

/**
 * Pure helpers for building deterministic dev seed data.
 *
 * This file intentionally avoids importing Prisma/db clients so unit tests can cover the
 * seed math without requiring DATABASE_URL or a running Postgres instance.
 */
export type MealTemplate = {
  mealPeriod: MealPeriod;
  name: string;
  calories: number;
  hour: number;
  minute?: number;
};

const SEED_MEAL_ITEMS = {
  spinachOmelet: { mealPeriod: MealPeriod.BREAKFAST, name: 'Spinach omelet', calories: 380, hour: 7 },
  sourdoughToast: { mealPeriod: MealPeriod.BREAKFAST, name: 'Sourdough toast', calories: 150, hour: 7, minute: 20 },
  latte: { mealPeriod: MealPeriod.BREAKFAST, name: 'Latte', calories: 120, hour: 8, minute: 10 },

  appleWithPeanutButter: {
    mealPeriod: MealPeriod.MORNING_SNACK,
    name: 'Apple with peanut butter',
    calories: 180,
    hour: 10,
  },
  greekYogurt: { mealPeriod: MealPeriod.MORNING_SNACK, name: 'Greek yogurt', calories: 190, hour: 10 },

  turkeySandwich: { mealPeriod: MealPeriod.LUNCH, name: 'Turkey sandwich', calories: 640, hour: 13 },
  sideSalad: { mealPeriod: MealPeriod.LUNCH, name: 'Side salad', calories: 180, hour: 13, minute: 15 },
  chickenBurritoBowl: { mealPeriod: MealPeriod.LUNCH, name: 'Chicken burrito bowl', calories: 680, hour: 13 },

  proteinShake: { mealPeriod: MealPeriod.AFTERNOON_SNACK, name: 'Protein shake', calories: 210, hour: 16 },
  trailMix: { mealPeriod: MealPeriod.AFTERNOON_SNACK, name: 'Trail mix', calories: 160, hour: 16, minute: 25 },
  granolaBar: { mealPeriod: MealPeriod.AFTERNOON_SNACK, name: 'Granola bar', calories: 140, hour: 16, minute: 20 },

  chickenStirFry: { mealPeriod: MealPeriod.DINNER, name: 'Chicken stir-fry', calories: 770, hour: 19 },
  steamedRice: { mealPeriod: MealPeriod.DINNER, name: 'Steamed rice', calories: 200, hour: 19, minute: 15 },
  roastedVeggies: { mealPeriod: MealPeriod.DINNER, name: 'Roasted veggies', calories: 110, hour: 19, minute: 20 },

  darkChocolateSquare: { mealPeriod: MealPeriod.EVENING_SNACK, name: 'Dark chocolate square', calories: 120, hour: 21 },
  popcorn: { mealPeriod: MealPeriod.EVENING_SNACK, name: 'Popcorn', calories: 150, hour: 21, minute: 5 },
  iceCreamScoop: { mealPeriod: MealPeriod.EVENING_SNACK, name: 'Ice cream scoop', calories: 220, hour: 21, minute: 10 },
} satisfies Record<string, MealTemplate>;

const WEEK_MEAL_PLANS: MealTemplate[][] = [
  // 2460 kcal: full day + extra afternoon snack item (multi-item meal).
  [
    SEED_MEAL_ITEMS.spinachOmelet,
    SEED_MEAL_ITEMS.appleWithPeanutButter,
    SEED_MEAL_ITEMS.turkeySandwich,
    SEED_MEAL_ITEMS.proteinShake,
    SEED_MEAL_ITEMS.trailMix,
    SEED_MEAL_ITEMS.chickenStirFry,
    SEED_MEAL_ITEMS.darkChocolateSquare,
  ],
  // 2200 kcal: no morning snack / evening snack, dinner has multiple items.
  [
    SEED_MEAL_ITEMS.spinachOmelet,
    SEED_MEAL_ITEMS.turkeySandwich,
    SEED_MEAL_ITEMS.proteinShake,
    SEED_MEAL_ITEMS.chickenStirFry,
    SEED_MEAL_ITEMS.steamedRice,
  ],
  // 1920 kcal: lunch empty, breakfast + afternoon snack have multiple items.
  [
    SEED_MEAL_ITEMS.spinachOmelet,
    SEED_MEAL_ITEMS.latte,
    SEED_MEAL_ITEMS.appleWithPeanutButter,
    SEED_MEAL_ITEMS.proteinShake,
    SEED_MEAL_ITEMS.granolaBar,
    SEED_MEAL_ITEMS.chickenStirFry,
    SEED_MEAL_ITEMS.darkChocolateSquare,
  ],
  // 2110 kcal: breakfast empty, lunch has multiple items.
  [
    SEED_MEAL_ITEMS.greekYogurt,
    SEED_MEAL_ITEMS.turkeySandwich,
    SEED_MEAL_ITEMS.sideSalad,
    SEED_MEAL_ITEMS.proteinShake,
    SEED_MEAL_ITEMS.chickenStirFry,
    SEED_MEAL_ITEMS.darkChocolateSquare,
  ],
  // 1600 kcal: dinner empty, swapped lunch + swapped evening snack.
  [
    SEED_MEAL_ITEMS.spinachOmelet,
    SEED_MEAL_ITEMS.appleWithPeanutButter,
    SEED_MEAL_ITEMS.chickenBurritoBowl,
    SEED_MEAL_ITEMS.proteinShake,
    SEED_MEAL_ITEMS.popcorn,
  ],
  // 2350 kcal: afternoon snack empty, breakfast + dinner have multiple items.
  [
    SEED_MEAL_ITEMS.spinachOmelet,
    SEED_MEAL_ITEMS.sourdoughToast,
    SEED_MEAL_ITEMS.appleWithPeanutButter,
    SEED_MEAL_ITEMS.turkeySandwich,
    SEED_MEAL_ITEMS.chickenStirFry,
    SEED_MEAL_ITEMS.roastedVeggies,
    SEED_MEAL_ITEMS.darkChocolateSquare,
  ],
  // 2340 kcal: morning snack empty, breakfast swapped in extra item + higher-cal evening snack.
  [
    SEED_MEAL_ITEMS.spinachOmelet,
    SEED_MEAL_ITEMS.latte,
    SEED_MEAL_ITEMS.turkeySandwich,
    SEED_MEAL_ITEMS.proteinShake,
    SEED_MEAL_ITEMS.chickenStirFry,
    SEED_MEAL_ITEMS.iceCreamScoop,
  ],
];

const SEED_WEIGHT_WEEKLY_SWING_GRAMS = [260, -190, 210, -160, 280, -230, 130] as const;
const SEED_WEIGHT_PHASE_ONE_DAYS = 35;
const SEED_WEIGHT_PHASE_TWO_DAYS = 30;
const SEED_WEIGHT_PHASE_ONE_DAILY_CHANGE_GRAMS = -35;
const SEED_WEIGHT_PHASE_TWO_DAILY_CHANGE_GRAMS = -8;
const SEED_WEIGHT_PHASE_THREE_DAILY_CHANGE_GRAMS = -28;
const SEED_WEIGHT_MONTHLY_WAVE_AMPLITUDE_GRAMS = 120;
const SEED_WEIGHT_SPIKE_PRIMARY_GRAMS = 360;
const SEED_WEIGHT_SPIKE_SECONDARY_GRAMS = 180;

/**
 * Build a new Date by adding the provided day offset using UTC math (no DST surprises).
 */
export function addUtcDays(date: Date, offset: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + offset);
  return result;
}

/**
 * Return an array of UTC-normalized DATE values ending on "today" in the provided time zone.
 *
 * Dates are returned in ascending order (oldest -> newest).
 */
export function getPastDateRangeDates(timeZone: string, days: number, now: Date = new Date()): Date[] {
  const rangeDays = Number.isFinite(days) ? Math.max(1, Math.trunc(days)) : 1;
  const todayLocalDate = formatDateToLocalDateString(now, timeZone);
  const today = normalizeToUtcDateOnly(todayLocalDate);
  return Array.from({ length: rangeDays }, (_, index) => addUtcDays(today, index - (rangeDays - 1)));
}

/**
 * Return an array of UTC-normalized DATE values covering the past week in the provided time zone.
 */
export function getPastWeekDates(timeZone: string, now: Date = new Date()): Date[] {
  return getPastDateRangeDates(timeZone, 7, now);
}

/**
 * Return a deterministic seeded scale weight with visible day-to-day volatility and multi-month trend shifts.
 *
 * The generated pattern intentionally includes:
 * - mixed up/down day-to-day movement (water/noise)
 * - a mid-period plateau-like segment
 * - stronger late trend movement
 */
export function getSeedWeightGramsForDayIndex(dayIndex: number, startingWeightGrams: number): number {
  const safeIndex = Math.max(0, Math.trunc(dayIndex));
  const phaseOneCumulative = SEED_WEIGHT_PHASE_ONE_DAYS * SEED_WEIGHT_PHASE_ONE_DAILY_CHANGE_GRAMS;
  const phaseTwoCumulative = SEED_WEIGHT_PHASE_TWO_DAYS * SEED_WEIGHT_PHASE_TWO_DAILY_CHANGE_GRAMS;

  const trendOffset =
    safeIndex < SEED_WEIGHT_PHASE_ONE_DAYS
      ? safeIndex * SEED_WEIGHT_PHASE_ONE_DAILY_CHANGE_GRAMS
      : safeIndex < SEED_WEIGHT_PHASE_ONE_DAYS + SEED_WEIGHT_PHASE_TWO_DAYS
      ? phaseOneCumulative + (safeIndex - SEED_WEIGHT_PHASE_ONE_DAYS) * SEED_WEIGHT_PHASE_TWO_DAILY_CHANGE_GRAMS
      : phaseOneCumulative +
        phaseTwoCumulative +
        (safeIndex - SEED_WEIGHT_PHASE_ONE_DAYS - SEED_WEIGHT_PHASE_TWO_DAYS) *
          SEED_WEIGHT_PHASE_THREE_DAILY_CHANGE_GRAMS;

  const weeklySwing = SEED_WEIGHT_WEEKLY_SWING_GRAMS[safeIndex % SEED_WEIGHT_WEEKLY_SWING_GRAMS.length] ?? 0;
  const monthlyWave = Math.round(Math.sin((safeIndex / 14) * Math.PI) * SEED_WEIGHT_MONTHLY_WAVE_AMPLITUDE_GRAMS);
  const periodicSpike =
    safeIndex % 29 === 0
      ? SEED_WEIGHT_SPIKE_PRIMARY_GRAMS
      : safeIndex % 29 === 1
      ? SEED_WEIGHT_SPIKE_SECONDARY_GRAMS
      : 0;

  return Math.max(30000, Math.round(startingWeightGrams + trendOffset + weeklySwing + monthlyWave + periodicSpike));
}

/**
 * Choose a deterministic created_at timestamp that keeps seeded days within /log bounds.
 */
export function getSeedUserCreatedAt(seedDays: Date[], timeZone: string): Date {
  const earliestSeedDay = seedDays[0];
  if (!earliestSeedDay) {
    return new Date();
  }

  const seedDateIso = earliestSeedDay.toISOString().slice(0, 10);
  const candidateHoursUtc = [12, 0, 6, 18];

  for (const hour of candidateHoursUtc) {
    const candidate = new Date(earliestSeedDay);
    candidate.setUTCHours(hour, 0, 0, 0);

    try {
      if (formatDateToLocalDateString(candidate, timeZone) === seedDateIso) {
        return candidate;
      }
    } catch {
      // Ignore invalid timezone inputs (we'll fall back to a best-effort value below).
    }
  }

  const fallback = new Date(earliestSeedDay);
  fallback.setUTCHours(12, 0, 0, 0);
  return fallback;
}

/**
 * Return a deterministic-but-varied meal plan for the provided seed day index.
 *
 * This keeps local dev data reproducible while exercising UI states like:
 * - different day totals
 * - empty meals (no items for a meal period)
 * - multi-item meals (multiple food logs in one meal period)
 */
export function getMealTemplatesForSeedDayIndex(dayIndex: number): MealTemplate[] {
  const plan = WEEK_MEAL_PLANS[dayIndex % WEEK_MEAL_PLANS.length];
  return plan ?? [];
}

/**
 * Build meal logs for a given seed day using the varied meal templates.
 */
export function buildMealLogsForDay(
  userId: number,
  day: Date,
  dayIndex: number
): Array<{
  user_id: number;
  date: Date;
  local_date: Date;
  meal_period: MealPeriod;
  name: string;
  calories: number;
}> {
  const templates = getMealTemplatesForSeedDayIndex(dayIndex);

  return templates.map((template) => {
    const mealDate = new Date(day);
    mealDate.setUTCHours(template.hour, template.minute ?? 0, 0, 0);
    return {
      user_id: userId,
      date: mealDate,
      local_date: day,
      meal_period: template.mealPeriod,
      name: template.name,
      calories: template.calories,
    };
  });
}

/** Build representative completion rows for the seeded calibration history. */
export function buildCompletedFoodLogDays(userId: number, days: Date[], completedAt: Date) {
  return days.map((day) => ({
    user_id: userId,
    local_date: day,
    status: FoodLogDayStatus.COMPLETE,
    origin: FoodLogDayOrigin.IMPORT,
    completed_at: completedAt,
  }));
}
