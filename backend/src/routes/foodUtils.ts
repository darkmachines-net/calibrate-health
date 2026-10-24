/** @file Request validation and normalization shared by food search, logging, and edit routes. */

import type { MealPeriod } from '@prisma/client';
import { getSafeUtcTodayDateOnlyInTimeZone, parseLocalDateOnly } from '../utils/date';
import { parseMealPeriod } from '../utils/mealPeriod';
import {
  parseNonNegativeNumber,
  parsePositiveInteger,
  parsePositiveNumber,
  resolveLanguageCode,
} from '../utils/requestParsing';
import { normalizeOptionalString, normalizeServingUnitLabel } from './myFoodsUtils';

/**
 * Parsing/validation helpers for food search and food log endpoints.
 *
 * These stay Prisma-free so they can be unit tested without database setup.
 */
type FoodSearchParams = {
  query: string | undefined;
  barcode: string | undefined;
  page: number | undefined;
  pageSize: number | undefined;
  quantityInGrams: number | undefined;
  languageCode: string | undefined;
};

export type FoodSearchParamsParseResult =
  | { ok: true; params: FoodSearchParams }
  | { ok: false; statusCode: number; message: string };

const normalizeBarcodeDigits = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, '').trim();
  return digits.length > 0 ? digits : undefined;
};

const isBarcodeCandidate = (value: string): boolean => {
  const digits = normalizeBarcodeDigits(value);
  if (!digits) return false;
  return digits.length === 8 || digits.length === 12 || digits.length === 13 || digits.length === 14;
};

/**
 * Parse and validate `/api/food/search` query params.
 *
 * Returns a friendly 400 when neither query nor barcode are present.
 */
export function parseFoodSearchParams(opts: {
  query: Record<string, unknown>;
  acceptLanguageHeader: unknown;
}): FoodSearchParamsParseResult {
  const queryParam =
    typeof opts.query.q === 'string'
      ? opts.query.q.trim()
      : typeof opts.query.query === 'string'
        ? opts.query.query.trim()
        : undefined;
  const rawBarcode = typeof opts.query.barcode === 'string' ? opts.query.barcode : undefined;
  const barcode = normalizeBarcodeDigits(rawBarcode);
  let resolvedQuery = queryParam;
  let resolvedBarcode = barcode;

  if (!resolvedBarcode && queryParam && isBarcodeCandidate(queryParam)) {
    resolvedBarcode = normalizeBarcodeDigits(queryParam);
    resolvedQuery = undefined;
  }

  if (!resolvedQuery && !resolvedBarcode) {
    return { ok: false, statusCode: 400, message: 'Provide a search query or barcode.' };
  }

  let page: number | undefined;
  if (opts.query.page !== undefined) {
    const parsedPage = parsePositiveInteger(opts.query.page);
    if (parsedPage === null) {
      return { ok: false, statusCode: 400, message: 'Invalid page' };
    }
    page = parsedPage;
  }

  let pageSize: number | undefined;
  if (opts.query.pageSize !== undefined) {
    const parsedPageSize = parsePositiveInteger(opts.query.pageSize);
    if (parsedPageSize === null) {
      return { ok: false, statusCode: 400, message: 'Invalid page size' };
    }
    pageSize = parsedPageSize;
  }

  let quantityInGrams: number | undefined;
  if (opts.query.grams !== undefined) {
    const parsedGrams = parsePositiveNumber(opts.query.grams);
    if (parsedGrams === null) {
      return { ok: false, statusCode: 400, message: 'Invalid grams' };
    }
    quantityInGrams = parsedGrams;
  }

  const languageCode = resolveLanguageCode({
    queryLanguageCode: opts.query.lc,
    acceptLanguageHeader: opts.acceptLanguageHeader,
  });

  return {
    ok: true,
    params: {
      query: resolvedQuery || undefined,
      barcode: resolvedBarcode,
      page,
      pageSize,
      quantityInGrams,
      languageCode,
    },
  };
}

export type FoodLogCreateParseResult =
  | {
      ok: true;
      kind: 'MY_FOOD';
      mealPeriod: MealPeriod;
      localDate: Date;
      entryTimestamp: Date;
      myFoodId: number;
      servingsConsumed: number;
    }
  | {
      ok: true;
      kind: 'MANUAL';
      mealPeriod: MealPeriod;
      localDate: Date;
      entryTimestamp: Date;
      name: string;
      calories: number;
      servingsConsumed: number | null;
      servingSizeQuantitySnapshot: number | null;
      servingUnitLabelSnapshot: string | null;
      caloriesPerServingSnapshot: number | null;
      externalSource: string | null;
      externalId: string | null;
      brandSnapshot: string | null;
      localeSnapshot: string | null;
      barcodeSnapshot: string | null;
      measureLabelSnapshot: string | null;
      gramsPerMeasureSnapshot: number | null;
      measureQuantitySnapshot: number | null;
      gramsTotalSnapshot: number | null;
    }
  | { ok: false; statusCode: number; message: string };

/**
 * Parse and validate a create-food-log request body.
 *
 * This is Prisma-free by design; it only validates user inputs and computes date defaults.
 */
export function parseFoodLogCreateBody(opts: {
  body: unknown;
  userTimeZone: unknown;
  now?: Date;
}): FoodLogCreateParseResult {
  if (!opts.body || typeof opts.body !== 'object') {
    return { ok: false, statusCode: 400, message: 'Invalid request body' };
  }

  const body = opts.body as Record<string, unknown>;
  const now = opts.now ?? new Date();

  const parsedMealPeriod = parseMealPeriod(body.meal_period);
  if (!parsedMealPeriod) {
    return { ok: false, statusCode: 400, message: 'Invalid meal period' };
  }

  const rawDate = body.date;

  let localDate: Date;
  if (rawDate === undefined || rawDate === null || (typeof rawDate === 'string' && rawDate.trim().length === 0)) {
    localDate = getSafeUtcTodayDateOnlyInTimeZone(opts.userTimeZone, now);
  } else {
    try {
      localDate = parseLocalDateOnly(rawDate);
    } catch {
      return { ok: false, statusCode: 400, message: 'Invalid date' };
    }
  }

  const entryTimestamp = typeof rawDate === 'string' && rawDate.trim().length > 0
    ? new Date(rawDate)
    : now;
  if (Number.isNaN(entryTimestamp.getTime())) {
    return { ok: false, statusCode: 400, message: 'Invalid date' };
  }

  const wantsMyFood =
    body.my_food_id !== undefined && body.my_food_id !== null && String(body.my_food_id).trim().length > 0;
  const wantsManual = body.name !== undefined || body.calories !== undefined;
  if (wantsMyFood && wantsManual) {
    return {
      ok: false,
      statusCode: 400,
      message: 'Provide either my_food_id+servings_consumed or name+calories, not both.',
    };
  }

  if (wantsMyFood) {
    const myFoodId = parsePositiveInteger(body.my_food_id);
    if (myFoodId === null) {
      return { ok: false, statusCode: 400, message: 'Invalid my food id' };
    }

    const servingsConsumed = parsePositiveNumber(body.servings_consumed);
    if (servingsConsumed === null) {
      return { ok: false, statusCode: 400, message: 'Invalid servings consumed' };
    }

    return {
      ok: true,
      kind: 'MY_FOOD',
      mealPeriod: parsedMealPeriod,
      localDate,
      entryTimestamp,
      myFoodId,
      servingsConsumed,
    };
  }

  const trimmedName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!trimmedName) {
    return { ok: false, statusCode: 400, message: 'Invalid name' };
  }

  const caloriesNumber = parseNonNegativeNumber(body.calories);
  if (caloriesNumber === null) {
    return { ok: false, statusCode: 400, message: 'Invalid calories' };
  }
  const calories = Math.round(caloriesNumber);

  const servingsConsumed =
    body.servings_consumed !== undefined && body.servings_consumed !== null && String(body.servings_consumed).trim().length > 0
      ? parsePositiveNumber(body.servings_consumed)
      : null;
  if (body.servings_consumed !== undefined && body.servings_consumed !== null && servingsConsumed === null) {
    return { ok: false, statusCode: 400, message: 'Invalid servings consumed' };
  }

  const servingSizeQuantitySnapshot =
    body.serving_size_quantity_snapshot !== undefined &&
    body.serving_size_quantity_snapshot !== null &&
    String(body.serving_size_quantity_snapshot).trim().length > 0
      ? parsePositiveNumber(body.serving_size_quantity_snapshot)
      : null;
  if (
    body.serving_size_quantity_snapshot !== undefined &&
    body.serving_size_quantity_snapshot !== null &&
    servingSizeQuantitySnapshot === null
  ) {
    return { ok: false, statusCode: 400, message: 'Invalid serving size quantity snapshot' };
  }

  const servingUnitLabelSnapshot =
    body.serving_unit_label_snapshot !== undefined && body.serving_unit_label_snapshot !== null
      ? normalizeServingUnitLabel(body.serving_unit_label_snapshot)
      : null;
  if (
    body.serving_unit_label_snapshot !== undefined &&
    body.serving_unit_label_snapshot !== null &&
    servingUnitLabelSnapshot === null
  ) {
    return { ok: false, statusCode: 400, message: 'Invalid serving unit label snapshot' };
  }

  const caloriesPerServingRaw = body.calories_per_serving_snapshot;
  const parsedCaloriesPerServing =
    caloriesPerServingRaw !== undefined && caloriesPerServingRaw !== null && String(caloriesPerServingRaw).trim().length > 0
      ? parseNonNegativeNumber(caloriesPerServingRaw)
      : null;
  if (caloriesPerServingRaw !== undefined && caloriesPerServingRaw !== null && parsedCaloriesPerServing === null) {
    return { ok: false, statusCode: 400, message: 'Invalid calories per serving snapshot' };
  }
  const caloriesPerServingSnapshot =
    parsedCaloriesPerServing ?? (servingsConsumed && servingsConsumed > 0 ? calories / servingsConsumed : null);

  const gramsPerMeasureSnapshot =
    body.grams_per_measure_snapshot !== undefined &&
    body.grams_per_measure_snapshot !== null &&
    String(body.grams_per_measure_snapshot).trim().length > 0
      ? parsePositiveNumber(body.grams_per_measure_snapshot)
      : null;
  if (
    body.grams_per_measure_snapshot !== undefined &&
    body.grams_per_measure_snapshot !== null &&
    gramsPerMeasureSnapshot === null
  ) {
    return { ok: false, statusCode: 400, message: 'Invalid grams per measure snapshot' };
  }

  const measureQuantitySnapshot =
    body.measure_quantity_snapshot !== undefined &&
    body.measure_quantity_snapshot !== null &&
    String(body.measure_quantity_snapshot).trim().length > 0
      ? parsePositiveNumber(body.measure_quantity_snapshot)
      : null;
  if (
    body.measure_quantity_snapshot !== undefined &&
    body.measure_quantity_snapshot !== null &&
    measureQuantitySnapshot === null
  ) {
    return { ok: false, statusCode: 400, message: 'Invalid measure quantity snapshot' };
  }

  const gramsTotalSnapshot =
    body.grams_total_snapshot !== undefined && body.grams_total_snapshot !== null && String(body.grams_total_snapshot).trim().length > 0
      ? parsePositiveNumber(body.grams_total_snapshot)
      : null;
  if (body.grams_total_snapshot !== undefined && body.grams_total_snapshot !== null && gramsTotalSnapshot === null) {
    return { ok: false, statusCode: 400, message: 'Invalid grams total snapshot' };
  }

  return {
    ok: true,
    kind: 'MANUAL',
    mealPeriod: parsedMealPeriod,
    localDate,
    entryTimestamp,
    name: trimmedName,
    calories,
    servingsConsumed,
    servingSizeQuantitySnapshot,
    servingUnitLabelSnapshot,
    caloriesPerServingSnapshot,
    externalSource: normalizeOptionalString(body.external_source),
    externalId: normalizeOptionalString(body.external_id),
    brandSnapshot: normalizeOptionalString(body.brand),
    localeSnapshot: normalizeOptionalString(body.locale),
    barcodeSnapshot: normalizeOptionalString(body.barcode),
    measureLabelSnapshot: normalizeOptionalString(body.measure_label),
    gramsPerMeasureSnapshot,
    measureQuantitySnapshot,
    gramsTotalSnapshot,
  };
}

type FoodLogUpdateData = Partial<{
  name: string;
  calories: number;
  meal_period: MealPeriod;
  servings_consumed: number | null;
  calories_per_serving_snapshot: number | null;
  measure_quantity_snapshot: number | null;
  grams_total_snapshot: number | null;
}>;

export type FoodLogUpdateParseResult =
  | { ok: true; updateData: FoodLogUpdateData }
  | { ok: false; statusCode: number; message: string };

// Retains precise gram snapshots without persisting floating-point noise.
const FOOD_LOG_SNAPSHOT_DECIMAL_SCALE = 1_000_000;

/**
 * Parse and validate a PATCH-food-log request body.
 */
export function parseFoodLogUpdateBody(opts: {
  body: unknown;
  existing: {
    calories_per_serving_snapshot?: number | null;
    servings_consumed?: number | null;
    grams_per_measure_snapshot?: number | null;
    measure_quantity_snapshot?: number | null;
    grams_total_snapshot?: number | null;
  };
}): FoodLogUpdateParseResult {
  if (!opts.body || typeof opts.body !== 'object') {
    return { ok: false, statusCode: 400, message: 'Invalid request body' };
  }

  const body = opts.body as Record<string, unknown>;

  const updateData: FoodLogUpdateData = {};
  const hasExplicitCalories = body.calories !== undefined;

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return { ok: false, statusCode: 400, message: 'Invalid name' };
    }
    updateData.name = body.name.trim();
  }

  if (body.calories !== undefined) {
    const parsedCalories = parseNonNegativeNumber(body.calories);
    if (parsedCalories === null) {
      return { ok: false, statusCode: 400, message: 'Invalid calories' };
    }
    updateData.calories = Math.round(parsedCalories);
  }

  if (body.meal_period !== undefined) {
    const parsedMealPeriod = parseMealPeriod(body.meal_period);
    if (!parsedMealPeriod) {
      return { ok: false, statusCode: 400, message: 'Invalid meal period' };
    }
    updateData.meal_period = parsedMealPeriod;
  }

  if (body.servings_consumed !== undefined) {
    const parsedServings = parsePositiveNumber(body.servings_consumed);
    if (parsedServings === null) {
      return { ok: false, statusCode: 400, message: 'Invalid servings consumed' };
    }

    if (
      !hasExplicitCalories &&
      (opts.existing.calories_per_serving_snapshot === null || opts.existing.calories_per_serving_snapshot === undefined)
    ) {
      return { ok: false, statusCode: 400, message: 'This entry does not include serving info.' };
    }

    updateData.servings_consumed = parsedServings;

    if (
      !hasExplicitCalories &&
      opts.existing.calories_per_serving_snapshot !== null &&
      opts.existing.calories_per_serving_snapshot !== undefined
    ) {
      updateData.calories = Math.round(parsedServings * opts.existing.calories_per_serving_snapshot);
    }

    const hasMeasureSnapshots =
      (opts.existing.measure_quantity_snapshot !== null && opts.existing.measure_quantity_snapshot !== undefined) ||
      (opts.existing.grams_per_measure_snapshot !== null && opts.existing.grams_per_measure_snapshot !== undefined) ||
      (opts.existing.grams_total_snapshot !== null && opts.existing.grams_total_snapshot !== undefined);
    if (hasMeasureSnapshots) {
      updateData.measure_quantity_snapshot = parsedServings;

      let gramsPerMeasure = opts.existing.grams_per_measure_snapshot;
      if (gramsPerMeasure === null || gramsPerMeasure === undefined || gramsPerMeasure <= 0) {
        const previousMeasureQuantity =
          opts.existing.measure_quantity_snapshot ?? opts.existing.servings_consumed;
        if (
          previousMeasureQuantity !== null && previousMeasureQuantity !== undefined && previousMeasureQuantity > 0 &&
          opts.existing.grams_total_snapshot !== null && opts.existing.grams_total_snapshot !== undefined &&
          opts.existing.grams_total_snapshot > 0
        ) {
          gramsPerMeasure = opts.existing.grams_total_snapshot / previousMeasureQuantity;
        }
      }

      if (gramsPerMeasure !== null && gramsPerMeasure !== undefined && gramsPerMeasure > 0) {
        updateData.grams_total_snapshot =
          Math.round(parsedServings * gramsPerMeasure * FOOD_LOG_SNAPSHOT_DECIMAL_SCALE) /
          FOOD_LOG_SNAPSHOT_DECIMAL_SCALE;
      } else if (
        opts.existing.grams_total_snapshot !== null &&
        opts.existing.grams_total_snapshot !== undefined
      ) {
        // A total without a per-measure ratio cannot be rescaled; do not retain a stale total.
        updateData.grams_total_snapshot = null;
      }
    }
  }

  if (hasExplicitCalories && updateData.calories !== undefined) {
    const servings =
      updateData.servings_consumed ??
      (opts.existing.servings_consumed !== null && opts.existing.servings_consumed !== undefined
        ? opts.existing.servings_consumed
        : null);

    if (servings && servings > 0) {
      updateData.calories_per_serving_snapshot = updateData.calories / servings;
    }
  }

  if (Object.keys(updateData).length === 0) {
    return { ok: false, statusCode: 400, message: 'No fields to update' };
  }

  return { ok: true, updateData };
}
