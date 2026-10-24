import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
    ActivityDaySummaryPayload,
    HealthConnectRecordUpsert,
    HealthConnectSyncPayload,
    HealthConnectSyncResponse
} from '@calibrate/api-client';
import { ACTIVITY_RECORD_TYPES, type ActivityRecordType } from '@calibrate/shared';
import * as Crypto from 'expo-crypto';
import type { GetChangesResults } from 'react-native-health-connect';
import {
    aggregateHealthConnectRecords,
    getHealthConnectChanges,
    readHealthConnectRecords
} from './native';
import {
    buildDaySummary,
    buildLocalDayRanges,
    localDateForRecord,
    normalizeAggregateValue,
    normalizeHealthConnectRecord,
    type LocalDayRange,
    type NativeSyncRecordType
} from './normalize';
import type {
    HealthConnectFeature,
    HealthConnectFeatureSelection
} from './types';
import { healthConnectAccountScope } from './storageScope';

const INITIAL_HISTORY_DAYS = 30;
const MAX_CHANGES_PER_UPLOAD = 500;
const TOKEN_STORAGE_PREFIX = '@calibrate/health-connect/token/v1';
const PENDING_STORAGE_PREFIX = '@calibrate/health-connect/pending/v1';

type Storage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

type SyncApi = {
    syncHealthConnect: (
        payload: HealthConnectSyncPayload,
        operationId: string
    ) => Promise<HealthConnectSyncResponse>;
};

type NativeAdapter = {
    getChanges: typeof getHealthConnectChanges;
    readRecords: typeof readHealthConnectRecords;
    aggregateRecords: typeof aggregateHealthConnectRecords;
};

type RecordTypeDescriptor = {
    feature: HealthConnectFeature;
    nativeType: NativeSyncRecordType;
    activityType: ActivityRecordType;
};

type PendingUpload = {
    nextToken: string;
    timeZone: string;
    nextPageIndex: number;
    pages: Array<{
        operationId: string;
        payload: HealthConnectSyncPayload;
    }>;
};

export type HealthConnectSyncResult = {
    lastSuccessfulSyncAt: string;
    syncedFeatures: HealthConnectFeature[];
    missingFeatures: HealthConnectFeature[];
};

export type HealthConnectSyncOptions = {
    serverUrl: string;
    userId: number;
    timeZone: string;
    selection: HealthConnectFeatureSelection;
    grantedFeatures: HealthConnectFeature[];
    api: SyncApi;
    storage?: Storage;
    native?: NativeAdapter;
    now?: Date;
    shouldContinue?: () => boolean;
};

const RECORD_TYPES: RecordTypeDescriptor[] = [
    { feature: 'steps', nativeType: 'Steps', activityType: ACTIVITY_RECORD_TYPES.STEPS },
    { feature: 'active_calories', nativeType: 'ActiveCaloriesBurned', activityType: ACTIVITY_RECORD_TYPES.ACTIVE_CALORIES },
    { feature: 'total_calories', nativeType: 'TotalCaloriesBurned', activityType: ACTIVITY_RECORD_TYPES.TOTAL_CALORIES },
    { feature: 'exercise', nativeType: 'ExerciseSession', activityType: ACTIVITY_RECORD_TYPES.EXERCISE_SESSION },
    { feature: 'weight', nativeType: 'Weight', activityType: ACTIVITY_RECORD_TYPES.WEIGHT }
];

function tokenKey(serverUrl: string, userId: number, recordType: ActivityRecordType): string {
    return `${TOKEN_STORAGE_PREFIX}/${healthConnectAccountScope(serverUrl, userId)}/${recordType}`;
}

function pendingKey(serverUrl: string, userId: number, recordType: ActivityRecordType): string {
    return `${PENDING_STORAGE_PREFIX}/${healthConnectAccountScope(serverUrl, userId)}/${recordType}`;
}

export class HealthConnectSyncCancelledError extends Error {
    constructor() {
        super('Health Connect sync was cancelled because the active account or connection changed.');
        this.name = 'HealthConnectSyncCancelledError';
    }
}

function assertCanContinue(shouldContinue: () => boolean): void {
    if (!shouldContinue()) throw new HealthConnectSyncCancelledError();
}

function parseTokenReceipt(value: string | null, timeZone: string): string | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as { token?: unknown; timeZone?: unknown };
        return typeof parsed.token === 'string' && parsed.timeZone === timeZone ? parsed.token : null;
    } catch {
        return null;
    }
}

function chunk<T>(values: T[], size: number): T[][] {
    if (values.length === 0) return [[]];
    const chunks: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }
    return chunks;
}

function chunkChanges(
    upserts: HealthConnectRecordUpsert[],
    deletedRecordIds: string[]
): Array<{ upserts: HealthConnectRecordUpsert[]; deletedRecordIds: string[] }> {
    const pages: Array<{ upserts: HealthConnectRecordUpsert[]; deletedRecordIds: string[] }> = [];
    let upsertIndex = 0;
    let deletionIndex = 0;
    while (upsertIndex < upserts.length || deletionIndex < deletedRecordIds.length) {
        const pageUpserts = upserts.slice(upsertIndex, upsertIndex + MAX_CHANGES_PER_UPLOAD);
        upsertIndex += pageUpserts.length;
        const remaining = MAX_CHANGES_PER_UPLOAD - pageUpserts.length;
        const pageDeletions = deletedRecordIds.slice(deletionIndex, deletionIndex + remaining);
        deletionIndex += pageDeletions.length;
        pages.push({ upserts: pageUpserts, deletedRecordIds: pageDeletions });
    }
    return pages.length > 0 ? pages : [{ upserts: [], deletedRecordIds: [] }];
}

async function operationId(payload: HealthConnectSyncPayload, pageIndex: number): Promise<string> {
    const digest = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        JSON.stringify({ pageIndex, payload })
    );
    return `health-connect:${payload.record_type.toLowerCase()}:${digest.slice(0, 48)}`;
}

async function persistPending(
    storage: Storage,
    serverUrl: string,
    userId: number,
    activityType: ActivityRecordType,
    timeZone: string,
    shouldContinue: () => boolean,
    payloads: HealthConnectSyncPayload[]
): Promise<PendingUpload> {
    const pending: PendingUpload = {
        nextToken: payloads[payloads.length - 1].next_changes_token,
        timeZone,
        nextPageIndex: 0,
        pages: await Promise.all(payloads.map(async (payload, index) => ({
            operationId: await operationId(payload, index),
            payload
        })))
    };
    assertCanContinue(shouldContinue);
    await storage.setItem(pendingKey(serverUrl, userId, activityType), JSON.stringify(pending));
    assertCanContinue(shouldContinue);
    return pending;
}

function parsePending(value: string | null): PendingUpload | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as PendingUpload;
        if (
            typeof parsed.nextToken !== 'string'
            || typeof parsed.timeZone !== 'string'
            || !Number.isInteger(parsed.nextPageIndex)
            || !Array.isArray(parsed.pages)
            || parsed.pages.some(({ payload }) => payload.upserts?.some(({ client_record_version: version }) => (
                version !== undefined
                && version !== null
                && !/^\d+$/.test(version)
            )))
        ) return null;
        return parsed;
    } catch {
        return null;
    }
}

async function replayPending(
    storage: Storage,
    api: SyncApi,
    serverUrl: string,
    userId: number,
    activityType: ActivityRecordType,
    pending: PendingUpload,
    shouldContinue: () => boolean
): Promise<void> {
    for (let index = pending.nextPageIndex; index < pending.pages.length; index += 1) {
        const page = pending.pages[index];
        assertCanContinue(shouldContinue);
        const response = await api.syncHealthConnect(page.payload, page.operationId);
        assertCanContinue(shouldContinue);
        if (response.checkpoint_advanced !== true) {
            throw new Error('The Calibrate server did not acknowledge the Health Connect checkpoint.');
        }
        pending.nextPageIndex = index + 1;
        await storage.setItem(pendingKey(serverUrl, userId, activityType), JSON.stringify(pending));
        assertCanContinue(shouldContinue);
    }
    // Keep the pending receipt until the acknowledged token is durable locally.
    assertCanContinue(shouldContinue);
    await storage.setItem(
        tokenKey(serverUrl, userId, activityType),
        JSON.stringify({ token: pending.nextToken, timeZone: pending.timeZone })
    );
    assertCanContinue(shouldContinue);
    await storage.removeItem(pendingKey(serverUrl, userId, activityType));
}

async function resumePending(
    storage: Storage,
    api: SyncApi,
    serverUrl: string,
    userId: number,
    activityType: ActivityRecordType,
    timeZone: string,
    shouldContinue: () => boolean
): Promise<void> {
    assertCanContinue(shouldContinue);
    const key = pendingKey(serverUrl, userId, activityType);
    const raw = await storage.getItem(key);
    const pending = parsePending(raw);
    if (!pending) {
        if (raw) await storage.removeItem(key);
        return;
    }
    if (pending.timeZone !== timeZone) {
        await storage.removeItem(key);
        await storage.removeItem(tokenKey(serverUrl, userId, activityType));
        return;
    }
    await replayPending(storage, api, serverUrl, userId, activityType, pending, shouldContinue);
}

async function readInitialRecords(
    native: NativeAdapter,
    descriptor: RecordTypeDescriptor,
    ranges: LocalDayRange[]
): Promise<HealthConnectRecordUpsert[]> {
    const records: HealthConnectRecordUpsert[] = [];
    let pageToken: string | undefined;
    do {
        const page = await native.readRecords(
            descriptor.nativeType,
            {
                operator: 'between',
                startTime: ranges[0].startTime,
                endTime: ranges[ranges.length - 1].endTime
            },
            pageToken
        );
        records.push(...page.records.map((record) =>
            normalizeHealthConnectRecord(descriptor.nativeType, record)
        ));
        pageToken = page.pageToken;
    } while (pageToken);
    return records;
}

async function aggregateDaySummaries(
    native: NativeAdapter,
    descriptors: RecordTypeDescriptor[],
    ranges: LocalDayRange[],
    observedAt: string
): Promise<ActivityDaySummaryPayload[]> {
    const aggregateDescriptors = descriptors.filter(({ nativeType }) => nativeType !== 'Weight');
    if (aggregateDescriptors.length === 0) return [];

    const summaries: ActivityDaySummaryPayload[] = [];
    for (const range of ranges) {
        const values: Parameters<typeof buildDaySummary>[2] = {};
        const aggregates = await Promise.all(aggregateDescriptors.map(async (descriptor) => ({
            descriptor,
            value: await native.aggregateRecords(descriptor.nativeType, {
                operator: 'between',
                startTime: range.startTime,
                endTime: range.endTime
            })
        })));
        for (const { descriptor, value } of aggregates) {
            const normalized = normalizeAggregateValue(descriptor.nativeType, value);
            if (descriptor.nativeType === 'Steps') values.steps = normalized;
            if (descriptor.nativeType === 'ActiveCaloriesBurned') values.activeCaloriesKcal = normalized;
            if (descriptor.nativeType === 'TotalCaloriesBurned') values.totalCaloriesKcal = normalized;
            if (descriptor.nativeType === 'ExerciseSession') values.exerciseMinutes = normalized;
        }
        const summary = buildDaySummary(range.localDate, observedAt, values);
        if (summary) summaries.push(summary);
    }
    return summaries;
}

function rangesForDates(allRanges: LocalDayRange[], dates: Set<string>): LocalDayRange[] {
    return allRanges.filter(({ localDate }) => dates.has(localDate));
}

async function uploadPayloads(
    storage: Storage,
    api: SyncApi,
    serverUrl: string,
    userId: number,
    activityType: ActivityRecordType,
    timeZone: string,
    shouldContinue: () => boolean,
    payloads: HealthConnectSyncPayload[]
): Promise<void> {
    const pending = await persistPending(
        storage,
        serverUrl,
        userId,
        activityType,
        timeZone,
        shouldContinue,
        payloads
    );
    await replayPending(storage, api, serverUrl, userId, activityType, pending, shouldContinue);
}

async function resetRecordType(options: {
    descriptor: RecordTypeDescriptor;
    aggregateDescriptors: RecordTypeDescriptor[];
    ranges: LocalDayRange[];
    observedAt: string;
    includeSummaries: boolean;
    serverUrl: string;
    userId: number;
    timeZone: string;
    shouldContinue: () => boolean;
    api: SyncApi;
    storage: Storage;
    native: NativeAdapter;
}): Promise<void> {
    const checkpoint = await options.native.getChanges(options.descriptor.nativeType);
    const records = await readInitialRecords(options.native, options.descriptor, options.ranges);
    const summaries = options.includeSummaries
        ? await aggregateDaySummaries(
            options.native,
            options.aggregateDescriptors,
            options.ranges,
            options.observedAt
        )
        : [];
    const payloads = chunk(records, MAX_CHANGES_PER_UPLOAD).map((upserts, index) => ({
        sync_mode: 'reset' as const,
        record_type: options.descriptor.activityType,
        previous_changes_token: null,
        next_changes_token: checkpoint.nextChangesToken,
        upserts,
        deleted_record_ids: [],
        ...(index === 0 ? {
            replace_window: {
                start_date: options.ranges[0].localDate,
                end_date: options.ranges[options.ranges.length - 1].localDate
            }
        } : {}),
        day_summaries: index === 0 ? summaries : []
    })) as HealthConnectSyncPayload[];
    await uploadPayloads(
        options.storage,
        options.api,
        options.serverUrl,
        options.userId,
        options.descriptor.activityType,
        options.timeZone,
        options.shouldContinue,
        payloads
    );
}

async function incrementalRecordType(options: {
    descriptor: RecordTypeDescriptor;
    aggregateDescriptors: RecordTypeDescriptor[];
    ranges: LocalDayRange[];
    timeZone: string;
    observedAt: string;
    includeCurrentSummary: boolean;
    serverUrl: string;
    userId: number;
    api: SyncApi;
    storage: Storage;
    native: NativeAdapter;
    token: string;
    shouldContinue: () => boolean;
}): Promise<'complete' | 'expired'> {
    let previousToken = options.token;
    let includeCurrentSummary = options.includeCurrentSummary;
    while (true) {
        const changes: GetChangesResults = await options.native.getChanges(
            options.descriptor.nativeType,
            previousToken
        );
        if (changes.changesTokenExpired) return 'expired';
        const upserts = changes.upsertionChanges.map(({ record }) =>
            normalizeHealthConnectRecord(options.descriptor.nativeType, record)
        );
        const dates = new Set<string>();
        if (includeCurrentSummary) dates.add(options.ranges[options.ranges.length - 1].localDate);
        for (const record of upserts) dates.add(localDateForRecord(record, options.timeZone));
        // A deletion does not include its former date, so rebuild the bounded history to remove stale totals.
        if (changes.deletionChanges.length > 0) {
            for (const range of options.ranges) dates.add(range.localDate);
        }
        const summaryRanges = rangesForDates(options.ranges, dates);
        const summaries = await aggregateDaySummaries(
            options.native,
            options.aggregateDescriptors,
            summaryRanges,
            options.observedAt
        );
        const changePages = chunkChanges(
            upserts,
            changes.deletionChanges.map(({ recordId }) => recordId)
        );
        const payloads = changePages.map((page, index) => ({
            sync_mode: 'incremental' as const,
            record_type: options.descriptor.activityType,
            previous_changes_token: previousToken,
            // Intermediate chunks leave the server CAS checkpoint unchanged.
            next_changes_token: index === changePages.length - 1
                ? changes.nextChangesToken
                : previousToken,
            upserts: page.upserts,
            deleted_record_ids: page.deletedRecordIds,
            day_summaries: index === 0 ? summaries : []
        })) as HealthConnectSyncPayload[];
        await uploadPayloads(
            options.storage,
            options.api,
            options.serverUrl,
            options.userId,
            options.descriptor.activityType,
            options.timeZone,
            options.shouldContinue,
            payloads
        );
        previousToken = changes.nextChangesToken;
        includeCurrentSummary = false;
        if (!changes.hasMore) return 'complete';
    }
}

function isTokenMismatch(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('body' in error)) return false;
    const body = (error as { body?: unknown }).body;
    return Boolean(body && typeof body === 'object' && 'code' in body
        && (body as { code?: unknown }).code === 'HEALTH_CONNECT_TOKEN_MISMATCH');
}

/** Run read-only foreground reconciliation without allowing Health Connect errors to escape the provider. */
export async function synchronizeHealthConnect(
    options: HealthConnectSyncOptions
): Promise<HealthConnectSyncResult> {
    const storage = options.storage ?? AsyncStorage;
    const native = options.native ?? {
        getChanges: getHealthConnectChanges,
        readRecords: readHealthConnectRecords,
        aggregateRecords: aggregateHealthConnectRecords
    };
    const now = options.now ?? new Date();
    const shouldContinue = options.shouldContinue ?? (() => true);
    assertCanContinue(shouldContinue);
    const observedAt = now.toISOString();
    const granted = new Set(options.grantedFeatures);
    const selectedDescriptors = RECORD_TYPES.filter(({ feature }) => options.selection[feature]);
    const descriptors = selectedDescriptors.filter(({ feature }) => granted.has(feature));
    const missingFeatures = selectedDescriptors
        .filter(({ feature }) => !granted.has(feature))
        .map(({ feature }) => feature);
    if (descriptors.length === 0) {
        throw new Error('Health Connect access is missing. Open Manage access and allow at least one selected data type.');
    }
    const ranges = buildLocalDayRanges(options.timeZone, now, INITIAL_HISTORY_DAYS);
    let summariesUploaded = false;

    for (const descriptor of descriptors) {
        try {
            await resumePending(
                storage,
                options.api,
                options.serverUrl,
                options.userId,
                descriptor.activityType,
                options.timeZone,
                shouldContinue
            );
        } catch (error) {
            if (!isTokenMismatch(error)) throw error;
            // A server reset or restored app backup can invalidate a locally pending CAS page.
            await storage.removeItem(tokenKey(options.serverUrl, options.userId, descriptor.activityType));
            await storage.removeItem(pendingKey(options.serverUrl, options.userId, descriptor.activityType));
        }
        assertCanContinue(shouldContinue);
        const storedToken = await storage.getItem(
            tokenKey(options.serverUrl, options.userId, descriptor.activityType)
        );
        const token = parseTokenReceipt(storedToken, options.timeZone);
        if (storedToken && !token) {
            await storage.removeItem(tokenKey(options.serverUrl, options.userId, descriptor.activityType));
            await storage.removeItem(pendingKey(options.serverUrl, options.userId, descriptor.activityType));
        }
        try {
            if (!token) {
                await resetRecordType({
                    descriptor,
                    aggregateDescriptors: descriptors,
                    ranges,
                    observedAt,
                    includeSummaries: !summariesUploaded,
                    serverUrl: options.serverUrl,
                    userId: options.userId,
                    timeZone: options.timeZone,
                    shouldContinue,
                    api: options.api,
                    storage,
                    native
                });
                summariesUploaded = true;
                continue;
            }

            const result = await incrementalRecordType({
                descriptor,
                aggregateDescriptors: descriptors,
                ranges,
                timeZone: options.timeZone,
                observedAt,
                includeCurrentSummary: !summariesUploaded,
                serverUrl: options.serverUrl,
                userId: options.userId,
                api: options.api,
                storage,
                native,
                token,
                shouldContinue
            });
            summariesUploaded = true;
            if (result === 'expired') {
                await storage.removeItem(tokenKey(options.serverUrl, options.userId, descriptor.activityType));
                await storage.removeItem(pendingKey(options.serverUrl, options.userId, descriptor.activityType));
                await resetRecordType({
                    descriptor,
                    aggregateDescriptors: descriptors,
                    ranges,
                    observedAt,
                    includeSummaries: true,
                    serverUrl: options.serverUrl,
                    userId: options.userId,
                    timeZone: options.timeZone,
                    shouldContinue,
                    api: options.api,
                    storage,
                    native
                });
            }
        } catch (error) {
            if (!isTokenMismatch(error)) throw error;
            await storage.removeItem(tokenKey(options.serverUrl, options.userId, descriptor.activityType));
            await storage.removeItem(pendingKey(options.serverUrl, options.userId, descriptor.activityType));
            await resetRecordType({
                descriptor,
                aggregateDescriptors: descriptors,
                ranges,
                observedAt,
                includeSummaries: true,
                serverUrl: options.serverUrl,
                userId: options.userId,
                timeZone: options.timeZone,
                shouldContinue,
                api: options.api,
                storage,
                native
            });
        }
    }

    return {
        lastSuccessfulSyncAt: observedAt,
        syncedFeatures: descriptors.map(({ feature }) => feature),
        missingFeatures
    };
}

export function getActionableHealthConnectSyncError(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    if (/permission|security|access|denied/i.test(message)) {
        return 'Health Connect access changed. Open Manage access, allow the selected data types, and try again.';
    }
    if (/network|fetch|timed out|offline/i.test(message)) {
        return 'Health activity could not reach this Calibrate server. Check the connection and try again.';
    }
    return 'Health activity could not sync. Try again from Health Connect settings.';
}

/** Remove device-local checkpoints after revocation so reconnect always performs a safe reset. */
export async function clearHealthConnectSyncStorage(
    serverUrl: string,
    userId: number,
    storage: Storage = AsyncStorage
): Promise<void> {
    await Promise.all(RECORD_TYPES.flatMap(({ activityType }) => [
        storage.removeItem(tokenKey(serverUrl, userId, activityType)),
        storage.removeItem(pendingKey(serverUrl, userId, activityType))
    ]));
}

export const HEALTH_CONNECT_SYNC_STORAGE_KEYS = {
    token: tokenKey,
    pending: pendingKey
};
