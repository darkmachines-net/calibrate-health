import express from 'express';
import multer from 'multer';
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { parseWeightToGrams, isWeightUnit, type WeightUnit } from '../utils/units';
import { isPolicyWeight } from '../../../shared/caloriePolicy';
import { markCurrentCaloriePlanForReviewIfUnsafe } from '../services/caloriePlanReview';
import { lockCaloriePlanningInputs } from '../services/caloriePlanningLock';
import { correctSameDayGoalStartingWeight, recordCorrectedGoalStartingWeight } from '../services/goalStartingWeight';
import type { MutationDatabase } from '../services/clientOperations';
import { getSafeUtcTodayDateOnlyInTimeZone, parseLocalDateOnly } from '../utils/date';
import { refreshMaterializedWeightTrendsBestEffort } from '../services/materializedWeightTrend';
import {
  buildImportTimestamp,
  inferLoseItWeightUnit,
  partitionLoseItWeightImportsByAsOfDate,
  parseLoseItExport,
  type LoseItFoodLogImport,
  type LoseItWeightImport,
} from '../services/loseItImport';
import { getAuthenticatedUser, requireAuthenticatedUser } from '../middleware/authenticatedUser';

/**
 * Import endpoints for Lose It zip exports (preview + execute).
 */
const router = express.Router();

const MAX_LOSE_IT_ZIP_BYTES = 25 * 1024 * 1024; // Protects memory usage for zip parsing.
const FOOD_INSERT_BATCH_SIZE = 250; // Keeps createMany payloads small for Prisma + Postgres.
const FOOD_DELETE_BATCH_SIZE = 200; // Keeps deleteMany IN lists manageable.
const WEIGHT_UPSERT_BATCH_SIZE = 50; // Throttle upsert batches to avoid overloading the DB.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOSE_IT_ZIP_BYTES },
});

type FoodConflictMode = 'MERGE' | 'REPLACE' | 'SKIP';
type WeightConflictMode = 'KEEP' | 'OVERWRITE';

type LoseItImportOptions = {
  weightUnit: WeightUnit;
  foodConflictMode: FoodConflictMode;
  weightConflictMode: WeightConflictMode;
  includeBodyFat: boolean;
};

function buildFutureWeightWarning(count: number): string | null {
  if (count <= 0) return null;
  return `${count} future-dated weight ${count === 1 ? 'entry was' : 'entries were'} excluded.`;
}

function partitionWeightsByPolicy(imports: LoseItWeightImport[], unit: WeightUnit) {
  return imports.reduce<{ eligible: LoseItWeightImport[]; invalid: LoseItWeightImport[] }>((result, entry) => {
    try {
      const weightGrams = parseWeightToGrams(entry.weightValue, unit);
      (isPolicyWeight(weightGrams) ? result.eligible : result.invalid).push(entry);
    } catch {
      result.invalid.push(entry);
    }
    return result;
  }, { eligible: [], invalid: [] });
}

function buildInvalidWeightWarning(count: number): string | null {
  if (count <= 0) return null;
  return `${count} weight ${count === 1 ? 'entry was' : 'entries were'} outside the supported range and excluded.`;
}

router.use(requireAuthenticatedUser);

router.post('/loseit/preview', upload.single('file'), async (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!req.file) {
    return res.status(400).json({ message: 'Missing export zip' });
  }

  let parsed;
  try {
    parsed = parseLoseItExport(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ message: 'Unable to read that export zip.' });
  }

  const fallbackUnit = isWeightUnit(user?.weight_unit) ? user.weight_unit : 'KG';
  const unitGuess = inferLoseItWeightUnit(parsed.profile, fallbackUnit);
  const currentLocalDate = getSafeUtcTodayDateOnlyInTimeZone(user.timezone);
  const partitionedWeights = partitionLoseItWeightImportsByAsOfDate(parsed.weights, currentLocalDate);
  const boundedWeights = partitionWeightsByPolicy(partitionedWeights.eligible, unitGuess.unit);
  const futureWeightWarning = buildFutureWeightWarning(partitionedWeights.future.length);
  const invalidWeightWarning = buildInvalidWeightWarning(boundedWeights.invalid.length);

  const foodDates = new Set(parsed.foodLogs.map((log) => log.localDate));
  const weightDates = new Set(boundedWeights.eligible.map((weight) => weight.localDate));
  const { startDate, endDate } = computeDateRange([...foodDates, ...weightDates]);

  const existingFoodDays = foodDates.size > 0 ? await countExistingFoodDays(user.id, foodDates) : 0;
  const existingWeightDays = weightDates.size > 0 ? await countExistingWeightDays(user.id, weightDates) : 0;

  res.json({
    summary: {
      foodLogs: parsed.foodLogs.length,
      foodLogDays: foodDates.size,
      weights: parsed.weights.length,
      bodyFat: parsed.bodyFat.length,
      startDate,
      endDate,
    },
    conflicts: {
      foodLogDays: existingFoodDays,
      weightDays: existingWeightDays,
    },
    warnings: [...parsed.warnings, ...[futureWeightWarning, invalidWeightWarning].filter((warning): warning is string => warning !== null)],
    weightUnitGuess: unitGuess.unit,
    weightUnitGuessSource: unitGuess.source,
    foodDayCompletionStatus: parsed.foodDayCompletionStatus,
    foodDayCompletionMessage:
      'Lose It does not include day completion history. Imported food days remain open until you resolve them in Calibrate.',
  });
});

router.post('/loseit/execute', upload.single('file'), async (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!req.file) {
    return res.status(400).json({ message: 'Missing export zip' });
  }

  const options = parseImportOptions(req.body);
  if (!options.ok) {
    return res.status(400).json({ message: options.message });
  }

  let parsed;
  try {
    parsed = parseLoseItExport(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ message: 'Unable to read that export zip.' });
  }

  const bodyFatByDate = new Map(parsed.bodyFat.map((entry) => [entry.localDate, entry.value]));

  const foodLogsToInsert = await resolveFoodLogsToInsert({
    userId: user.id,
    imports: parsed.foodLogs,
    conflictMode: options.value.foodConflictMode,
  });

  for (const batch of chunkArray(foodLogsToInsert.rows, FOOD_INSERT_BATCH_SIZE)) {
    if (batch.length === 0) continue;
    await prisma.foodLog.createMany({ data: batch });
  }

  const importedFoodLogs = foodLogsToInsert.rows.length;
  const skippedFoodLogs = foodLogsToInsert.skippedCount;

  const weightResult = await prisma.$transaction(async (tx) => {
    await lockCaloriePlanningInputs(tx, user.id);
    const currentUser = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { timezone: true } });
    const today = getSafeUtcTodayDateOnlyInTimeZone(currentUser.timezone);
    const partitionedWeights = partitionLoseItWeightImportsByAsOfDate(parsed.weights, today);
    const boundedWeights = partitionWeightsByPolicy(partitionedWeights.eligible, options.value.weightUnit);
    const result = await applyWeightImports({
      database: tx,
      userId: user.id,
      imports: boundedWeights.eligible,
      bodyFatByDate,
      weightUnit: options.value.weightUnit,
      conflictMode: options.value.weightConflictMode,
      includeBodyFat: options.value.includeBodyFat,
      baselineDate: today,
    });
    const correctedGoal = result.baselineWeightGrams === null ? null : await correctSameDayGoalStartingWeight(tx, {
      userId: user.id, metricDate: today, weightGrams: result.baselineWeightGrams, timezone: currentUser.timezone, today
    });
    if (result.imported > 0 || result.updated > 0) {
      await markCurrentCaloriePlanForReviewIfUnsafe(tx, user.id);
    }
    if (correctedGoal) await recordCorrectedGoalStartingWeight(tx, user.id, correctedGoal.id);
    return { ...result, futureCount: partitionedWeights.future.length, invalidCount: boundedWeights.invalid.length };
  });

  const importedWeights = weightResult.imported;
  const updatedWeights = weightResult.updated;
  const skippedWeights = weightResult.skipped + weightResult.futureCount + weightResult.invalidCount;
  const updatedBodyFat = weightResult.bodyFatUpdated;
  const futureWeightWarning = buildFutureWeightWarning(weightResult.futureCount);
  const invalidWeightWarning = buildInvalidWeightWarning(weightResult.invalidCount);
  if (importedWeights > 0 || updatedWeights > 0) {
    await refreshMaterializedWeightTrendsBestEffort(user.id);
  }

  res.json({
    food_logs: {
      total: parsed.foodLogs.length,
      valid: importedFoodLogs,
      invalid: skippedFoodLogs,
    },
    weights: {
      total: parsed.weights.length,
      valid: importedWeights + updatedWeights,
      invalid: skippedWeights,
    },
    importedFoodLogs,
    skippedFoodLogs,
    importedWeights,
    updatedWeights,
    skippedWeights,
    updatedBodyFat,
    warnings: [...parsed.warnings, ...[futureWeightWarning, invalidWeightWarning].filter((warning): warning is string => warning !== null)],
    foodDayCompletionStatus: parsed.foodDayCompletionStatus,
    foodDayCompletionMessage:
      'Completion history was unavailable, so imported food days remain unresolved.',
  });
});

export default router;

/**
 * Parse the import options payload and validate conflict modes.
 */
function parseImportOptions(body: Record<string, unknown> | undefined):
  | { ok: true; value: LoseItImportOptions }
  | { ok: false; message: string } {
  const weightUnit = body?.weight_unit;
  if (!isWeightUnit(weightUnit)) {
    return { ok: false, message: 'Invalid weight unit' };
  }

  const foodConflictMode = body?.food_conflict_mode;
  if (foodConflictMode !== 'MERGE' && foodConflictMode !== 'REPLACE' && foodConflictMode !== 'SKIP') {
    return { ok: false, message: 'Invalid food conflict mode' };
  }

  const weightConflictMode = body?.weight_conflict_mode;
  if (weightConflictMode !== 'KEEP' && weightConflictMode !== 'OVERWRITE') {
    return { ok: false, message: 'Invalid weight conflict mode' };
  }

  const includeBodyFatRaw = body?.include_body_fat;
  const includeBodyFat =
    includeBodyFatRaw === true ||
    includeBodyFatRaw === 'true' ||
    includeBodyFatRaw === '1' ||
    includeBodyFatRaw === 1;

  return {
    ok: true,
    value: {
      weightUnit,
      foodConflictMode,
      weightConflictMode,
      includeBodyFat,
    },
  };
}

/**
 * Count the number of import food log days that already exist for the user.
 */
async function countExistingFoodDays(userId: number, importDates: Set<string>): Promise<number> {
  const { minDate, maxDate } = computeDateRangeAsDates(importDates);
  if (!minDate || !maxDate) return 0;

  const existing = await prisma.foodLog.findMany({
    where: {
      user_id: userId,
      local_date: { gte: minDate, lte: maxDate },
    },
    select: { local_date: true },
  });

  const existingDates = new Set(existing.map((row) => formatUtcDateKey(row.local_date)));
  let count = 0;
  for (const date of importDates) {
    if (existingDates.has(date)) count += 1;
  }
  return count;
}

/**
 * Count the number of import weight days that already exist for the user.
 */
async function countExistingWeightDays(userId: number, importDates: Set<string>): Promise<number> {
  const { minDate, maxDate } = computeDateRangeAsDates(importDates);
  if (!minDate || !maxDate) return 0;

  const existing = await prisma.bodyMetric.findMany({
    where: {
      user_id: userId,
      date: { gte: minDate, lte: maxDate },
    },
    select: { date: true },
  });

  const existingDates = new Set(existing.map((row) => formatUtcDateKey(row.date)));
  let count = 0;
  for (const date of importDates) {
    if (existingDates.has(date)) count += 1;
  }
  return count;
}

/**
 * Build createMany rows for food logs, respecting conflict mode semantics.
 */
async function resolveFoodLogsToInsert(opts: {
  userId: number;
  imports: LoseItFoodLogImport[];
  conflictMode: FoodConflictMode;
}): Promise<{ rows: Prisma.FoodLogCreateManyInput[]; skippedCount: number }> {
  if (opts.imports.length === 0) {
    return { rows: [], skippedCount: 0 };
  }

  const dateMap = new Map<string, Date>();
  for (const entry of opts.imports) {
    dateMap.set(entry.localDate, entry.localDateValue);
  }

  if (opts.conflictMode === 'REPLACE') {
    for (const batch of chunkArray(Array.from(dateMap.values()), FOOD_DELETE_BATCH_SIZE)) {
      await prisma.foodLog.deleteMany({
        where: { user_id: opts.userId, local_date: { in: batch } },
      });
    }
  }

  const existingByDate = await buildExistingFoodFingerprintMap({
    userId: opts.userId,
    dateValues: Array.from(dateMap.values()),
    includeFingerprints: opts.conflictMode === 'MERGE',
  });

  const rows: Prisma.FoodLogCreateManyInput[] = [];
  let skippedCount = 0;

  for (const entry of opts.imports) {
    const dateKey = entry.localDate;

    if (opts.conflictMode === 'SKIP' && existingByDate.has(dateKey)) {
      skippedCount += 1;
      continue;
    }

    if (opts.conflictMode === 'MERGE') {
      const fingerprint = buildFoodFingerprint(entry);
      const existingSet = existingByDate.get(dateKey) ?? new Set<string>();
      if (existingSet.has(fingerprint)) {
        skippedCount += 1;
        continue;
      }
      existingSet.add(fingerprint);
      existingByDate.set(dateKey, existingSet);
    }

    rows.push({
      user_id: opts.userId,
      name: entry.name,
      calories: entry.calories,
      meal_period: entry.mealPeriod,
      date: entry.entryTimestamp,
      local_date: entry.localDateValue,
      servings_consumed: entry.servingsConsumed ?? null,
      serving_size_quantity_snapshot: entry.servingSizeQuantity ?? null,
      serving_unit_label_snapshot: entry.servingUnitLabel ?? null,
      calories_per_serving_snapshot: entry.caloriesPerServing ?? null,
    });
  }

  return { rows, skippedCount };
}

/**
 * Build a map of existing food log fingerprints by local date for merge deduping.
 */
async function buildExistingFoodFingerprintMap(opts: {
  userId: number;
  dateValues: Date[];
  includeFingerprints: boolean;
}): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (opts.dateValues.length === 0) return result;

  const minDate = opts.dateValues.reduce((min, value) => (value < min ? value : min));
  const maxDate = opts.dateValues.reduce((max, value) => (value > max ? value : max));

  const existing = await prisma.foodLog.findMany({
    where: {
      user_id: opts.userId,
      local_date: { gte: minDate, lte: maxDate },
    },
    select: {
      local_date: true,
      meal_period: true,
      name: true,
      calories: true,
      servings_consumed: true,
      serving_unit_label_snapshot: true,
    },
  });

  for (const row of existing) {
    const dateKey = formatUtcDateKey(row.local_date);
    const set = result.get(dateKey) ?? new Set<string>();
    if (opts.includeFingerprints) {
      const fingerprint = buildFoodFingerprint({
        localDate: dateKey,
        localDateValue: row.local_date,
        entryTimestamp: buildImportTimestamp(row.local_date),
        mealPeriod: row.meal_period,
        name: row.name,
        calories: row.calories,
        servingsConsumed: row.servings_consumed ?? null,
        servingUnitLabel: row.serving_unit_label_snapshot ?? null,
        servingSizeQuantity: null,
        caloriesPerServing: null,
      });
      set.add(fingerprint);
    }
    result.set(dateKey, set);
  }

  return result;
}

/**
 * Create a deterministic key for comparing food log rows during merge.
 */
function buildFoodFingerprint(entry: LoseItFoodLogImport): string {
  const normalizedName = entry.name.trim().toLowerCase();
  const servingsKey = entry.servingsConsumed !== null ? roundForFingerprint(entry.servingsConsumed) : '';
  const unitKey = entry.servingUnitLabel ? entry.servingUnitLabel.trim().toLowerCase() : '';
  return `${entry.localDate}|${entry.mealPeriod}|${normalizedName}|${entry.calories}|${servingsKey}|${unitKey}`;
}

/**
 * Apply weight imports, honoring KEEP/OVERWRITE behavior and optional body fat updates.
 */
async function applyWeightImports(opts: {
  database: MutationDatabase;
  userId: number;
  imports: LoseItWeightImport[];
  bodyFatByDate: Map<string, number>;
  weightUnit: WeightUnit;
  conflictMode: WeightConflictMode;
  includeBodyFat: boolean;
  baselineDate: Date;
}): Promise<{ imported: number; updated: number; skipped: number; bodyFatUpdated: number; baselineWeightGrams: number | null }> {
  if (opts.imports.length === 0) {
    return { imported: 0, updated: 0, skipped: 0, bodyFatUpdated: 0, baselineWeightGrams: null };
  }

  const dateValues = opts.imports.map((entry) => entry.localDateValue);
  const minDate = dateValues.reduce((min, value) => (value < min ? value : min));
  const maxDate = dateValues.reduce((max, value) => (value > max ? value : max));

  const existing = await opts.database.bodyMetric.findMany({
    where: { user_id: opts.userId, date: { gte: minDate, lte: maxDate } },
    select: { id: true, date: true, body_fat_percent: true },
  });

  const existingByDate = new Map<string, { id: number; bodyFat: number | null }>();
  for (const row of existing) {
    existingByDate.set(formatUtcDateKey(row.date), { id: row.id, bodyFat: row.body_fat_percent });
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let bodyFatUpdated = 0;
  let baselineWeightGrams: number | null = null;

  if (opts.conflictMode === 'KEEP') {
    const createRows = [];
    for (const entry of opts.imports) {
      const dateKey = entry.localDate;
      if (existingByDate.has(dateKey)) {
        skipped += 1;
        continue;
      }

      const bodyFatValue = opts.includeBodyFat ? opts.bodyFatByDate.get(dateKey) ?? null : null;
      if (bodyFatValue !== null) {
        bodyFatUpdated += 1;
      }
      createRows.push({
        user_id: opts.userId,
        date: entry.localDateValue,
        weight_grams: parseWeightToGrams(entry.weightValue, opts.weightUnit),
        body_fat_percent: bodyFatValue,
      });
    }

    if (createRows.length > 0) {
      await opts.database.bodyMetric.createMany({ data: createRows });
      imported = createRows.length;
      baselineWeightGrams = createRows.find(row => row.date.getTime() === opts.baselineDate.getTime())?.weight_grams ?? null;
    }

    if (opts.includeBodyFat) {
      for (const entry of opts.imports) {
        const bodyFatValue = opts.bodyFatByDate.get(entry.localDate);
        if (bodyFatValue === undefined) continue;

        const existingMetric = existingByDate.get(entry.localDate);
        if (!existingMetric || existingMetric.bodyFat !== null) continue;

        await opts.database.bodyMetric.update({
          where: { id: existingMetric.id },
          data: { body_fat_percent: bodyFatValue },
        });
        bodyFatUpdated += 1;
      }
    }

    return { imported, updated, skipped, bodyFatUpdated, baselineWeightGrams };
  }

  const upserts = opts.imports.map((entry) => {
    const bodyFatValue = opts.includeBodyFat ? opts.bodyFatByDate.get(entry.localDate) : undefined;
    const updateData: { weight_grams: number; body_fat_percent?: number } = {
      weight_grams: parseWeightToGrams(entry.weightValue, opts.weightUnit),
    };
    if (bodyFatValue !== undefined) {
      updateData.body_fat_percent = bodyFatValue;
    }

    const createData = {
      user_id: opts.userId,
      date: entry.localDateValue,
      weight_grams: updateData.weight_grams,
      body_fat_percent: bodyFatValue ?? null,
    };

    return opts.database.bodyMetric.upsert({
      where: { user_id_date: { user_id: opts.userId, date: entry.localDateValue } },
      update: updateData,
      create: createData,
    });
  });

  for (const batch of chunkArray(upserts, WEIGHT_UPSERT_BATCH_SIZE)) {
    await Promise.all(batch);
  }

  for (const entry of opts.imports) {
    if (entry.localDateValue.getTime() === opts.baselineDate.getTime()) {
      baselineWeightGrams = parseWeightToGrams(entry.weightValue, opts.weightUnit);
    }
    if (existingByDate.has(entry.localDate)) {
      updated += 1;
    } else {
      imported += 1;
    }
  }

  if (opts.includeBodyFat) {
    for (const entry of opts.imports) {
      if (opts.bodyFatByDate.has(entry.localDate)) {
        bodyFatUpdated += 1;
      }
    }
  }

  return { imported, updated, skipped, bodyFatUpdated, baselineWeightGrams };
}

/**
 * Compute min/max ISO date strings for an ordered range.
 */
function computeDateRange(dates: string[]): { startDate: string | null; endDate: string | null } {
  if (dates.length === 0) return { startDate: null, endDate: null };
  let startDate = dates[0];
  let endDate = dates[0];
  for (const date of dates) {
    if (date < startDate) startDate = date;
    if (date > endDate) endDate = date;
  }
  return { startDate, endDate };
}

/**
 * Compute min/max Date values from a set of ISO date strings.
 */
function computeDateRangeAsDates(dates: Set<string>): { minDate: Date | null; maxDate: Date | null } {
  if (dates.size === 0) return { minDate: null, maxDate: null };
  const values = Array.from(dates).map((date) => parseLocalDateOnly(date));
  const minDate = values.reduce((min, value) => (value < min ? value : min));
  const maxDate = values.reduce((max, value) => (value > max ? value : max));
  return { minDate, maxDate };
}

/**
 * Convert a Date to a stable YYYY-MM-DD key (UTC).
 */
function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Round to a fixed precision for fingerprint comparisons.
 */
function roundForFingerprint(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * Split an array into fixed-size batches.
 */
function chunkArray<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let idx = 0; idx < items.length; idx += size) {
    result.push(items.slice(idx, idx + size));
  }
  return result;
}
