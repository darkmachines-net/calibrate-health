/** @file Validated meal/day copying with account ownership checks and immutable food-log snapshots. */

import type { FoodLog, MealPeriod } from '@prisma/client';
import { observeFoodActivityPlan } from './dailyCaloriePlans';
import { parseClientOperationId, recordSyncChange, type MutationDatabase } from './clientOperations';
import { getFoodDayWriteBlock, type FoodDayWriteBlock } from './foodTracking';
import { isValidIanaTimeZone, parseLocalDateOnly } from '../utils/date';
import { parseMealPeriod } from '../utils/mealPeriod';

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type FoodCopyMealMapping = {
  sourceMealPeriod: MealPeriod;
  targetMealPeriod: MealPeriod;
};

export type ParsedFoodCopyRequest = {
  operationId: string;
  sourceDate: Date;
  sourceDateKey: string;
  targetDate: Date;
  targetDateKey: string;
  mealMappings?: FoodCopyMealMapping[];
};

export type FoodCopyResponse = {
  operation_id: string;
  source_date: string;
  target_date: string;
  copied_count: number;
  food_logs: FoodLog[];
};

export type FoodCopyRequestParseResult =
  | { ok: true; request: ParsedFoodCopyRequest }
  | { ok: false; statusCode: 400; message: string };

const invalidRequest = (message: string): FoodCopyRequestParseResult => ({
  ok: false,
  statusCode: 400,
  message
});

const parseExactLocalDate = (value: unknown): { date: Date; key: string } | null => {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (!LOCAL_DATE_PATTERN.test(key)) return null;
  try {
    return { date: parseLocalDateOnly(key), key };
  } catch {
    return null;
  }
};

/** Validate and normalize the meal/day copy wire payload without accessing Prisma. */
export function parseFoodCopyRequest(options: {
  body: unknown;
  userTimeZone: unknown;
}): FoodCopyRequestParseResult {
  if (!options.body || typeof options.body !== 'object' || Array.isArray(options.body)) {
    return invalidRequest('Invalid request body');
  }
  if (!isValidIanaTimeZone(options.userTimeZone)) {
    return invalidRequest('Invalid user timezone');
  }

  const body = options.body as Record<string, unknown>;
  const operationId = parseClientOperationId(body.operation_id);
  if (!operationId) return invalidRequest('Invalid operation_id');

  const source = parseExactLocalDate(body.source_date);
  if (!source) return invalidRequest('Invalid source_date');
  const target = parseExactLocalDate(body.target_date);
  if (!target) return invalidRequest('Invalid target_date');

  if (body.meal_mappings === undefined) {
    if (source.key === target.key) {
      return invalidRequest('source_date and target_date must differ when copying a full day');
    }
    return {
      ok: true,
      request: {
        operationId,
        sourceDate: source.date,
        sourceDateKey: source.key,
        targetDate: target.date,
        targetDateKey: target.key
      }
    };
  }

  if (!Array.isArray(body.meal_mappings) || body.meal_mappings.length === 0) {
    return invalidRequest('meal_mappings must be a non-empty array when provided');
  }

  const mealMappings: FoodCopyMealMapping[] = [];
  const mappingPairs = new Set<string>();
  for (const rawMapping of body.meal_mappings) {
    if (!rawMapping || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) {
      return invalidRequest('Invalid meal mapping');
    }
    const mapping = rawMapping as Record<string, unknown>;
    const sourceMealPeriod = parseMealPeriod(mapping.source_meal_period);
    const targetMealPeriod = parseMealPeriod(mapping.target_meal_period);
    if (!sourceMealPeriod || !targetMealPeriod) {
      return invalidRequest('Invalid meal mapping');
    }
    if (source.key === target.key && sourceMealPeriod === targetMealPeriod) {
      return invalidRequest('A same-date meal copy must target a different meal period');
    }

    const pairKey = `${sourceMealPeriod}:${targetMealPeriod}`;
    if (mappingPairs.has(pairKey)) {
      return invalidRequest('Duplicate meal mapping');
    }
    mappingPairs.add(pairKey);
    mealMappings.push({ sourceMealPeriod, targetMealPeriod });
  }

  return {
    ok: true,
    request: {
      operationId,
      sourceDate: source.date,
      sourceDateKey: source.key,
      targetDate: target.date,
      targetDateKey: target.key,
      mealMappings
    }
  };
}

/** Build the stable semantic payload used to detect operation-ID reuse conflicts. */
export function foodCopyOperationPayload(request: ParsedFoodCopyRequest): unknown {
  return {
    operation_id: request.operationId,
    source_date: request.sourceDateKey,
    target_date: request.targetDateKey,
    ...(request.mealMappings === undefined
      ? {}
      : {
          meal_mappings: request.mealMappings.map((mapping) => ({
            source_meal_period: mapping.sourceMealPeriod,
            target_meal_period: mapping.targetMealPeriod
          }))
        })
  };
}

/** Copy owned snapshot rows and append their sync changes inside the caller's transaction. */
export async function copyFoodLogs(options: {
  tx: MutationDatabase;
  userId: number;
  request: ParsedFoodCopyRequest;
  operationId: string;
}): Promise<{ status: 200; body: FoodCopyResponse } | FoodDayWriteBlock> {
  await observeFoodActivityPlan(options.tx, options.userId, [options.request.targetDate]);
  const writeBlock = await getFoodDayWriteBlock({
    userId: options.userId,
    localDate: options.request.targetDate,
    db: options.tx
  });
  if (writeBlock) return writeBlock;

  const sourceMealPeriods = options.request.mealMappings === undefined
    ? undefined
    : Array.from(new Set(options.request.mealMappings.map((mapping) => mapping.sourceMealPeriod)));
  const sourceLogs = await options.tx.foodLog.findMany({
    where: {
      user_id: options.userId,
      local_date: options.request.sourceDate,
      ...(sourceMealPeriods === undefined ? {} : { meal_period: { in: sourceMealPeriods } })
    },
    orderBy: { created_at: 'asc' }
  });

  const targetPeriodsBySource = new Map<MealPeriod, MealPeriod[]>();
  for (const mapping of options.request.mealMappings ?? []) {
    const targetPeriods = targetPeriodsBySource.get(mapping.sourceMealPeriod) ?? [];
    targetPeriods.push(mapping.targetMealPeriod);
    targetPeriodsBySource.set(mapping.sourceMealPeriod, targetPeriods);
  }

  const copiedLogs: FoodLog[] = [];
  for (const sourceLog of sourceLogs) {
    const targetPeriods = options.request.mealMappings === undefined
      ? [sourceLog.meal_period]
      : targetPeriodsBySource.get(sourceLog.meal_period) ?? [];

    for (const targetMealPeriod of targetPeriods) {
      const copiedLog = await options.tx.foodLog.create({
        data: {
          user_id: options.userId,
          my_food_id: sourceLog.my_food_id,
          date: options.request.targetDate,
          local_date: options.request.targetDate,
          meal_period: targetMealPeriod,
          name: sourceLog.name,
          calories: sourceLog.calories,
          servings_consumed: sourceLog.servings_consumed,
          serving_size_quantity_snapshot: sourceLog.serving_size_quantity_snapshot,
          serving_unit_label_snapshot: sourceLog.serving_unit_label_snapshot,
          calories_per_serving_snapshot: sourceLog.calories_per_serving_snapshot,
          external_source: sourceLog.external_source,
          external_id: sourceLog.external_id,
          brand_snapshot: sourceLog.brand_snapshot,
          locale_snapshot: sourceLog.locale_snapshot,
          barcode_snapshot: sourceLog.barcode_snapshot,
          measure_label_snapshot: sourceLog.measure_label_snapshot,
          grams_per_measure_snapshot: sourceLog.grams_per_measure_snapshot,
          measure_quantity_snapshot: sourceLog.measure_quantity_snapshot,
          grams_total_snapshot: sourceLog.grams_total_snapshot
        }
      });
      copiedLogs.push(copiedLog);
      await recordSyncChange({
        tx: options.tx,
        userId: options.userId,
        entityType: 'food_log',
        entityId: copiedLog.id,
        action: 'upsert',
        operationId: options.operationId,
        payload: copiedLog
      });
    }
  }

  return {
    status: 200,
    body: {
      operation_id: options.request.operationId,
      source_date: options.request.sourceDateKey,
      target_date: options.request.targetDateKey,
      copied_count: copiedLogs.length,
      food_logs: copiedLogs
    }
  };
}
