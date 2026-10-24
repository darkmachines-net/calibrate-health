/** @file Health Connect record, deletion, and aggregate normalization using account-timezone date boundaries. */

import type { ActivityDaySummaryPayload, HealthConnectRecordUpsert } from '@calibrate/api-client';
import { formatDateOnlyInTimeZone } from '@calibrate/shared';

export type NativeSyncRecordType =
    | 'Steps'
    | 'ActiveCaloriesBurned'
    | 'TotalCaloriesBurned'
    | 'ExerciseSession'
    | 'Weight';

type JsonObject = Record<string, unknown>;

export type LocalDayRange = {
    localDate: string;
    startTime: string;
    endTime: string;
};

export type HealthConnectAggregateValues = {
    steps?: number | null;
    activeCaloriesKcal?: number | null;
    totalCaloriesKcal?: number | null;
    exerciseMinutes?: number | null;
};

function isObject(value: unknown): value is JsonObject {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Health Connect returned a record without ${label}.`);
    }
    return value;
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
}

function finiteNumber(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Health Connect returned an invalid ${label}.`);
    }
    return value;
}

function optionalInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function optionalNonNegativeInteger(value: unknown): number | null {
    const parsed = optionalInteger(value);
    return parsed !== null && parsed >= 0 ? parsed : null;
}

function zoneOffsetSeconds(value: unknown): number | null {
    if (!isObject(value)) return null;
    return optionalInteger(value.totalSeconds);
}

function addDays(dateOnly: string, days: number): string {
    const date = new Date(`${dateOnly}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function timeZoneParts(instant: Date, timeZone: string): number[] {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).formatToParts(instant);
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return [value('year'), value('month'), value('day'), value('hour'), value('minute'), value('second')];
}

/** Convert an IANA-local midnight to an instant, including DST boundary days. */
function localDateStartInstant(localDate: string, timeZone: string): Date {
    const [year, month, day] = localDate.split('-').map(Number);
    const targetWallTime = Date.UTC(year, month - 1, day);
    let candidate = targetWallTime;
    try {
        for (let iteration = 0; iteration < 4; iteration += 1) {
            const [localYear, localMonth, localDay, hour, minute, second] = timeZoneParts(
                new Date(candidate),
                timeZone
            );
            const renderedWallTime = Date.UTC(localYear, localMonth - 1, localDay, hour, minute, second);
            const nextCandidate = candidate + (targetWallTime - renderedWallTime);
            if (nextCandidate === candidate) break;
            candidate = nextCandidate;
        }
    } catch {
        return new Date(targetWallTime);
    }
    return new Date(candidate);
}

/** Build inclusive local-day ranges ending with the user's current local date. */
export function buildLocalDayRanges(timeZone: string, now: Date, dayCount: number): LocalDayRange[] {
    const today = formatDateOnlyInTimeZone(now, timeZone);
    const firstDate = addDays(today, -(Math.max(1, dayCount) - 1));
    return Array.from({ length: Math.max(1, dayCount) }, (_, index) => {
        const localDate = addDays(firstDate, index);
        return {
            localDate,
            startTime: localDateStartInstant(localDate, timeZone).toISOString(),
            endTime: localDateStartInstant(addDays(localDate, 1), timeZone).toISOString()
        };
    });
}

/** Convert one bridge record to the server's provenance-preserving wire shape. */
export function normalizeHealthConnectRecord(
    recordType: NativeSyncRecordType,
    value: unknown
): HealthConnectRecordUpsert {
    if (!isObject(value) || !isObject(value.metadata)) {
        throw new Error('Health Connect returned a record without provenance metadata.');
    }
    const metadata = value.metadata;
    const device = isObject(metadata.device) ? metadata.device : null;
    const instantaneous = recordType === 'Weight';
    const startTime = requiredString(instantaneous ? value.time : value.startTime, 'a start time');
    const endTime = instantaneous ? null : requiredString(value.endTime, 'an end time');
    const normalized = {
        record_id: requiredString(metadata.id, 'a source record ID'),
        data_origin: requiredString(metadata.dataOrigin, 'a data origin'),
        client_record_id: optionalString(metadata.clientRecordId),
        // The Android bridge exposes -1 when the source did not set a client version.
        client_record_version: optionalNonNegativeInteger(metadata.clientRecordVersion)?.toString() ?? null,
        source_updated_at: requiredString(metadata.lastModifiedTime, 'a source update time'),
        start_time: startTime,
        end_time: endTime,
        start_zone_offset_seconds: zoneOffsetSeconds(instantaneous ? value.zoneOffset : value.startZoneOffset),
        end_zone_offset_seconds: zoneOffsetSeconds(value.endZoneOffset),
        recording_method: optionalInteger(metadata.recordingMethod),
        device_type: device ? optionalInteger(device.type) : null,
        device_manufacturer: device ? optionalString(device.manufacturer) : null,
        device_model: device ? optionalString(device.model) : null
    };

    if (recordType === 'Steps') {
        return { ...normalized, count: Math.round(finiteNumber(value.count, 'step count')) };
    }
    if (recordType === 'ActiveCaloriesBurned' || recordType === 'TotalCaloriesBurned') {
        const energy = isObject(value.energy) ? value.energy : null;
        return { ...normalized, energy_kcal: finiteNumber(energy?.inKilocalories, 'energy value') };
    }
    if (recordType === 'Weight') {
        const weight = isObject(value.weight) ? value.weight : null;
        return { ...normalized, weight_grams: Math.round(finiteNumber(weight?.inGrams, 'weight value')) };
    }
    if (recordType === 'ExerciseSession') {
        return {
            ...normalized,
            exercise_type: Math.round(finiteNumber(value.exerciseType, 'exercise type')),
            title: optionalString(value.title),
            notes: optionalString(value.notes)
        };
    }
    throw new Error(`Unsupported Health Connect record type: ${recordType}`);
}

/** Groups a health record by its start instant in the account's IANA timezone. */
export function localDateForRecord(record: HealthConnectRecordUpsert, timeZone: string): string {
    return formatDateOnlyInTimeZone(new Date(record.start_time), timeZone);
}

/** Extracts finite steps, energy, or exercise values from native aggregate payloads. */
export function normalizeAggregateValue(recordType: NativeSyncRecordType, value: unknown): number {
    if (!isObject(value)) return 0;
    if (recordType === 'Steps') return finiteNumber(value.COUNT_TOTAL ?? 0, 'steps aggregate');
    if (recordType === 'ActiveCaloriesBurned') {
        const energy = isObject(value.ACTIVE_CALORIES_TOTAL) ? value.ACTIVE_CALORIES_TOTAL : null;
        return finiteNumber(energy?.inKilocalories ?? 0, 'active calorie aggregate');
    }
    if (recordType === 'TotalCaloriesBurned') {
        const energy = isObject(value.ENERGY_TOTAL) ? value.ENERGY_TOTAL : null;
        return finiteNumber(energy?.inKilocalories ?? 0, 'total calorie aggregate');
    }
    if (recordType === 'ExerciseSession') {
        const duration = isObject(value.EXERCISE_DURATION_TOTAL) ? value.EXERCISE_DURATION_TOTAL : null;
        return finiteNumber(duration?.inSeconds ?? 0, 'exercise duration aggregate') / 60;
    }
    return 0;
}

/** Builds a dated activity summary when at least one aggregate exists, retaining nulls for missing metrics. */
export function buildDaySummary(
    localDate: string,
    observedAt: string,
    values: HealthConnectAggregateValues
): ActivityDaySummaryPayload | null {
    const hasAggregate = Object.values(values).some((value) => value !== undefined && value !== null);
    if (!hasAggregate) return null;
    const base = {
        local_date: localDate,
        steps: values.steps ?? null,
        active_calories_kcal: values.activeCaloriesKcal ?? null,
        total_calories_kcal: values.totalCaloriesKcal ?? null,
        exercise_minutes: values.exerciseMinutes ?? null,
        observed_at: observedAt
    };
    if (typeof values.steps === 'number') return { ...base, steps: values.steps };
    if (typeof values.activeCaloriesKcal === 'number') {
        return { ...base, active_calories_kcal: values.activeCaloriesKcal };
    }
    if (typeof values.totalCaloriesKcal === 'number') {
        return { ...base, total_calories_kcal: values.totalCaloriesKcal };
    }
    return { ...base, exercise_minutes: values.exerciseMinutes as number };
}
