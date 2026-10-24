/** @file activity Utils: Validate and normalize one atomic Health Connect change-token page. */

import {
  ACTIVITY_RECORD_TYPES,
  type ActivityRecordType
} from '../../../shared/domain';
import { MAX_WEIGHT_GRAMS, MIN_WEIGHT_GRAMS } from '../../../shared/caloriePolicy';
import {
  addUtcDays,
  formatDateToLocalDateString,
  parseLocalDateOnly
} from '../utils/date';

const MAX_SYNC_CHANGES = 500;
const MAX_DAY_SUMMARIES = 366;
const MAX_TOKEN_LENGTH = 32_768;
const MAX_EXTERNAL_ID_LENGTH = 512;
const MAX_TEXT_LENGTH = 1_000;
const MAX_ZONE_OFFSET_SECONDS = 18 * 60 * 60;
const MAX_RANGE_DAYS = 366;

const RECORD_TYPES = new Set<ActivityRecordType>(Object.values(ACTIVITY_RECORD_TYPES));

type JsonObject = Record<string, unknown>;

export type ParsedActivityRecord = {
  externalId: string;
  dataOrigin: string;
  clientRecordId: string | null;
  clientRecordVersion: bigint | null;
  sourceUpdatedAt: Date;
  startTime: Date;
  endTime: Date | null;
  startZoneOffsetSeconds: number | null;
  endZoneOffsetSeconds: number | null;
  localDate: Date;
  stepCount: number | null;
  energyKcal: number | null;
  weightGrams: number | null;
  exerciseType: number | null;
  title: string | null;
  notes: string | null;
  recordingMethod: number | null;
  deviceType: number | null;
  deviceManufacturer: string | null;
  deviceModel: string | null;
};

export type ParsedActivityDaySummary = {
  localDate: Date;
  steps: number | null;
  activeCaloriesKcal: number | null;
  totalCaloriesKcal: number | null;
  exerciseMinutes: number | null;
  observedAt: Date;
};

export type ParsedHealthConnectSync = {
  syncMode: 'incremental' | 'reset';
  recordType: ActivityRecordType;
  previousChangesToken: string | null;
  nextChangesToken: string;
  replaceWindow: { start: Date; end: Date } | null;
  upserts: ParsedActivityRecord[];
  deletedRecordIds: string[];
  daySummaries: ParsedActivityDaySummary[];
};

export type ParsedActivityRange = {
  start: Date;
  end: Date;
  dateKeys: string[];
};

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function assertAllowedKeys(record: JsonObject, allowed: ReadonlySet<string>, label: string): void {
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${label} contains unsupported field ${unexpected}`);
}

function parseRequiredText(value: unknown, label: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string') throw new Error(`${label} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`Invalid ${label}`);
  return normalized;
}

function parseOptionalText(value: unknown, label: string, maxLength = MAX_TEXT_LENGTH): string | null {
  if (value === undefined || value === null || value === '') return null;
  return parseRequiredText(value, label, maxLength);
}

function parseDateTime(value: unknown, label: string): Date {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const normalized = value.trim();
  // Require an explicit UTC/offset suffix so ingestion never depends on the server's local timezone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid ${label}`);
  return parsed;
}

function parseNullableInteger(
  value: unknown,
  label: string,
  options: { minimum?: number; maximum?: number } = {}
): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label}`);
  const parsed = value as number;
  if (options.minimum !== undefined && parsed < options.minimum) throw new Error(`Invalid ${label}`);
  if (options.maximum !== undefined && parsed > options.maximum) throw new Error(`Invalid ${label}`);
  return parsed;
}

function parseNullableNumber(value: unknown, label: string, minimum = 0): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function parseClientRecordVersion(value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error('Invalid client_record_version');
}

function parseOffset(value: unknown, label: string): number | null {
  return parseNullableInteger(value, label, {
    minimum: -MAX_ZONE_OFFSET_SECONDS,
    maximum: MAX_ZONE_OFFSET_SECONDS
  });
}

function localDateForInstant(value: Date, timeZone: string): Date {
  try {
    return parseLocalDateOnly(formatDateToLocalDateString(value, timeZone));
  } catch {
    return parseLocalDateOnly(formatDateToLocalDateString(value, 'UTC'));
  }
}

const COMMON_RECORD_KEYS = new Set([
  'record_id',
  'data_origin',
  'client_record_id',
  'client_record_version',
  'source_updated_at',
  'start_time',
  'end_time',
  'start_zone_offset_seconds',
  'end_zone_offset_seconds',
  'recording_method',
  'device_type',
  'device_manufacturer',
  'device_model',
  'title',
  'notes'
]);

function parseActivityRecord(value: unknown, recordType: ActivityRecordType, timeZone: string): ParsedActivityRecord {
  if (!isObject(value)) throw new Error('Each upsert must be an object');

  const typeSpecificKey =
    recordType === ACTIVITY_RECORD_TYPES.STEPS
      ? 'count'
      : recordType === ACTIVITY_RECORD_TYPES.ACTIVE_CALORIES || recordType === ACTIVITY_RECORD_TYPES.TOTAL_CALORIES
        ? 'energy_kcal'
        : recordType === ACTIVITY_RECORD_TYPES.WEIGHT
          ? 'weight_grams'
          : 'exercise_type';
  assertAllowedKeys(value, new Set([...COMMON_RECORD_KEYS, typeSpecificKey]), 'Activity record');

  const startTime = parseDateTime(value.start_time, 'start_time');
  const endTime = value.end_time === undefined || value.end_time === null
    ? null
    : parseDateTime(value.end_time, 'end_time');
  const isInstantaneous = recordType === ACTIVITY_RECORD_TYPES.WEIGHT;
  if (!isInstantaneous && !endTime) throw new Error('end_time is required for interval records');
  if (endTime && endTime <= startTime) throw new Error('end_time must be after start_time');

  const stepCount = recordType === ACTIVITY_RECORD_TYPES.STEPS
    ? parseNullableInteger(value.count, 'count', { minimum: 1 })
    : null;
  const energyKcal = recordType === ACTIVITY_RECORD_TYPES.ACTIVE_CALORIES || recordType === ACTIVITY_RECORD_TYPES.TOTAL_CALORIES
    ? parseNullableNumber(value.energy_kcal, 'energy_kcal')
    : null;
  const weightGrams = recordType === ACTIVITY_RECORD_TYPES.WEIGHT
    ? parseNullableInteger(value.weight_grams, 'weight_grams', { minimum: MIN_WEIGHT_GRAMS, maximum: MAX_WEIGHT_GRAMS })
    : null;
  const exerciseType = recordType === ACTIVITY_RECORD_TYPES.EXERCISE_SESSION
    ? parseNullableInteger(value.exercise_type, 'exercise_type', { minimum: 0 })
    : null;

  if (recordType === ACTIVITY_RECORD_TYPES.STEPS && stepCount === null) throw new Error('count is required');
  if ((recordType === ACTIVITY_RECORD_TYPES.ACTIVE_CALORIES || recordType === ACTIVITY_RECORD_TYPES.TOTAL_CALORIES) && energyKcal === null) {
    throw new Error('energy_kcal is required');
  }
  if (recordType === ACTIVITY_RECORD_TYPES.WEIGHT && weightGrams === null) throw new Error('weight_grams is required');
  if (recordType === ACTIVITY_RECORD_TYPES.EXERCISE_SESSION && exerciseType === null) {
    throw new Error('exercise_type is required');
  }

  return {
    externalId: parseRequiredText(value.record_id, 'record_id', MAX_EXTERNAL_ID_LENGTH),
    dataOrigin: parseRequiredText(value.data_origin, 'data_origin', 255),
    clientRecordId: parseOptionalText(value.client_record_id, 'client_record_id', MAX_EXTERNAL_ID_LENGTH),
    clientRecordVersion: parseClientRecordVersion(value.client_record_version),
    sourceUpdatedAt: parseDateTime(value.source_updated_at, 'source_updated_at'),
    startTime,
    endTime,
    startZoneOffsetSeconds: parseOffset(value.start_zone_offset_seconds, 'start_zone_offset_seconds'),
    endZoneOffsetSeconds: parseOffset(value.end_zone_offset_seconds, 'end_zone_offset_seconds'),
    localDate: localDateForInstant(startTime, timeZone),
    stepCount,
    energyKcal,
    weightGrams,
    exerciseType,
    title: parseOptionalText(value.title, 'title', 500),
    notes: parseOptionalText(value.notes, 'notes', 2_000),
    recordingMethod: parseNullableInteger(value.recording_method, 'recording_method', { minimum: 0 }),
    deviceType: parseNullableInteger(value.device_type, 'device_type', { minimum: 0 }),
    deviceManufacturer: parseOptionalText(value.device_manufacturer, 'device_manufacturer', 255),
    deviceModel: parseOptionalText(value.device_model, 'device_model', 255)
  };
}

const DAY_SUMMARY_KEYS = new Set([
  'local_date',
  'steps',
  'active_calories_kcal',
  'total_calories_kcal',
  'exercise_minutes',
  'observed_at'
]);

function parseDaySummary(value: unknown): ParsedActivityDaySummary {
  if (!isObject(value)) throw new Error('Each day summary must be an object');
  assertAllowedKeys(value, DAY_SUMMARY_KEYS, 'Activity day summary');

  const steps = parseNullableInteger(value.steps, 'steps', { minimum: 0 });
  const activeCaloriesKcal = parseNullableNumber(value.active_calories_kcal, 'active_calories_kcal');
  const totalCaloriesKcal = parseNullableNumber(value.total_calories_kcal, 'total_calories_kcal');
  const exerciseMinutes = parseNullableNumber(value.exercise_minutes, 'exercise_minutes');
  if ([steps, activeCaloriesKcal, totalCaloriesKcal, exerciseMinutes].every((entry) => entry === null)) {
    throw new Error('Day summary must include at least one aggregate');
  }

  return {
    localDate: parseLocalDateOnly(value.local_date),
    steps,
    activeCaloriesKcal,
    totalCaloriesKcal,
    exerciseMinutes,
    observedAt: parseDateTime(value.observed_at, 'observed_at')
  };
}

/** Validate and normalize one atomic Health Connect change-token page. */
export function parseHealthConnectSyncBody(body: unknown, timeZone: string): ParsedHealthConnectSync {
  if (!isObject(body)) throw new Error('Request body must be an object');
  assertAllowedKeys(body, new Set([
    'sync_mode',
    'record_type',
    'previous_changes_token',
    'next_changes_token',
    'replace_window',
    'upserts',
    'deleted_record_ids',
    'day_summaries'
  ]), 'Health Connect sync request');

  const recordType = body.record_type;
  if (typeof recordType !== 'string' || !RECORD_TYPES.has(recordType as ActivityRecordType)) {
    throw new Error('Invalid record_type');
  }
  const syncMode = body.sync_mode;
  if (syncMode !== 'incremental' && syncMode !== 'reset') throw new Error('Invalid sync_mode');

  const previousChangesToken = body.previous_changes_token === null
    ? null
    : parseRequiredText(body.previous_changes_token, 'previous_changes_token', MAX_TOKEN_LENGTH);
  if (syncMode === 'reset' && previousChangesToken !== null) {
    throw new Error('Reset sync must use a null previous_changes_token');
  }
  const nextChangesToken = parseRequiredText(body.next_changes_token, 'next_changes_token', MAX_TOKEN_LENGTH);
  let replaceWindow: { start: Date; end: Date } | null = null;
  if (body.replace_window !== undefined) {
    if (syncMode !== 'reset') throw new Error('replace_window is allowed only for reset sync');
    if (!isObject(body.replace_window)) throw new Error('replace_window must be an object');
    assertAllowedKeys(body.replace_window, new Set(['start_date', 'end_date']), 'replace_window');
    const start = parseLocalDateOnly(body.replace_window.start_date);
    const end = parseLocalDateOnly(body.replace_window.end_date);
    if (end < start) throw new Error('replace_window end_date must not be before start_date');
    let dayCount = 0;
    for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
      dayCount += 1;
      if (dayCount > MAX_RANGE_DAYS) throw new Error(`replace_window cannot exceed ${MAX_RANGE_DAYS} days`);
    }
    replaceWindow = { start, end };
  }
  const upsertValues = body.upserts === undefined ? [] : body.upserts;
  const deletedValues = body.deleted_record_ids === undefined ? [] : body.deleted_record_ids;
  const summaryValues = body.day_summaries === undefined ? [] : body.day_summaries;
  if (!Array.isArray(upsertValues) || !Array.isArray(deletedValues) || !Array.isArray(summaryValues)) {
    throw new Error('upserts, deleted_record_ids, and day_summaries must be arrays');
  }
  if (upsertValues.length + deletedValues.length > MAX_SYNC_CHANGES) {
    throw new Error(`A sync page may contain at most ${MAX_SYNC_CHANGES} record changes`);
  }
  if (summaryValues.length > MAX_DAY_SUMMARIES) {
    throw new Error(`A sync page may contain at most ${MAX_DAY_SUMMARIES} day summaries`);
  }

  const upserts = upsertValues.map((value) => parseActivityRecord(value, recordType as ActivityRecordType, timeZone));
  const deletedRecordIds = deletedValues.map((value) => parseRequiredText(value, 'deleted record id', MAX_EXTERNAL_ID_LENGTH));
  const upsertIds = new Set<string>();
  for (const record of upserts) {
    if (upsertIds.has(record.externalId)) throw new Error('Duplicate upsert record id');
    upsertIds.add(record.externalId);
  }
  const deletedIds = new Set<string>();
  for (const recordId of deletedRecordIds) {
    if (deletedIds.has(recordId)) throw new Error('Duplicate deleted record id');
    if (upsertIds.has(recordId)) throw new Error('A record cannot be upserted and deleted in the same page');
    deletedIds.add(recordId);
  }

  const daySummaries = summaryValues.map(parseDaySummary);
  const summaryDates = new Set<string>();
  for (const summary of daySummaries) {
    const key = summary.localDate.toISOString().slice(0, 10);
    if (summaryDates.has(key)) throw new Error('Duplicate day summary date');
    summaryDates.add(key);
  }

  return {
    syncMode,
    recordType: recordType as ActivityRecordType,
    previousChangesToken,
    nextChangesToken,
    replaceWindow,
    upserts,
    deletedRecordIds,
    daySummaries
  };
}

/** Parse an inclusive local-date range, defaulting to the user's current local day. */
export function parseActivityRange(query: JsonObject, timeZone: string, now = new Date()): ParsedActivityRange {
  const startValue = query.start;
  const endValue = query.end;
  if ((startValue === undefined) !== (endValue === undefined)) {
    throw new Error('start and end must be provided together');
  }

  const today = localDateForInstant(now, timeZone);
  const start = startValue === undefined ? today : parseLocalDateOnly(startValue);
  const end = endValue === undefined ? today : parseLocalDateOnly(endValue);
  if (end < start) throw new Error('end must not be before start');

  const dateKeys: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
    if (dateKeys.length >= MAX_RANGE_DAYS) throw new Error(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);
    dateKeys.push(cursor.toISOString().slice(0, 10));
  }
  return { start, end, dateKeys };
}
