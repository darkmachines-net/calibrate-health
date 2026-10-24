/** @file Authenticated Health Connect source-record ingestion, synchronization, and account-scoped activity reads. */

import express from 'express';
import type { ActivityRecordType as PrismaActivityRecordType } from '@prisma/client';
import prisma from '../config/database';
import {
  ClientOperationConflictError,
  executeIdempotentMutation,
  parseClientOperationId,
  recordSyncChange,
  type MutationDatabase
} from '../services/clientOperations';
import {
  parseActivityRange,
  parseHealthConnectSyncBody,
  type ParsedActivityRecord,
  type ParsedActivityDaySummary
} from './activityUtils';
import { diagnosticOperationOutcomeForStatus, diagnosticsRegistry } from '../observability';
import { getAuthenticatedUser, requireAuthenticatedUser } from '../middleware/authenticatedUser';

const router = express.Router();
/** Reconcile one Health Connect change-token page and advance its device checkpoint atomically. */
router.use(requireAuthenticatedUser);

type StoredActivityRecord = {
  id: number;
  source_device_id: string;
  record_type: string;
  external_id: string;
  data_origin: string;
  client_record_id: string | null;
  client_record_version: bigint | null;
  source_updated_at: Date;
  start_time: Date;
  end_time: Date | null;
  start_zone_offset_seconds: number | null;
  end_zone_offset_seconds: number | null;
  local_date: Date;
  step_count: number | null;
  energy_kcal: number | null;
  weight_grams: number | null;
  exercise_type: number | null;
  title: string | null;
  notes: string | null;
  recording_method: number | null;
  device_type: number | null;
  device_manufacturer: string | null;
  device_model: string | null;
  created_at: Date;
  updated_at: Date;
};

type StoredDaySummary = {
  id: number;
  source_device_id: string;
  local_date: Date;
  steps: number | null;
  active_calories_kcal: number | null;
  total_calories_kcal: number | null;
  exercise_minutes: number | null;
  observed_at: Date;
  created_at: Date;
  updated_at: Date;
};

const toDateKey = (value: Date): string => value.toISOString().slice(0, 10);

/** Convert Prisma values to the JSON-safe source-record wire shape. */
function serializeActivityRecord(record: StoredActivityRecord) {
  return {
    id: record.id,
    record_type: record.record_type,
    record_id: record.external_id,
    data_origin: record.data_origin,
    client_record_id: record.client_record_id,
    client_record_version: record.client_record_version?.toString() ?? null,
    source_updated_at: record.source_updated_at.toISOString(),
    start_time: record.start_time.toISOString(),
    end_time: record.end_time?.toISOString() ?? null,
    start_zone_offset_seconds: record.start_zone_offset_seconds,
    end_zone_offset_seconds: record.end_zone_offset_seconds,
    local_date: toDateKey(record.local_date),
    count: record.step_count,
    energy_kcal: record.energy_kcal,
    weight_grams: record.weight_grams,
    exercise_type: record.exercise_type,
    title: record.title,
    notes: record.notes,
    recording_method: record.recording_method,
    device_type: record.device_type,
    device_manufacturer: record.device_manufacturer,
    device_model: record.device_model,
    created_at: record.created_at.toISOString(),
    updated_at: record.updated_at.toISOString()
  };
}

/** Convert a materialized aggregate row to a date-only, JSON-safe shape. */
function serializeDaySummary(summary: StoredDaySummary) {
  return {
    id: summary.id,
    local_date: toDateKey(summary.local_date),
    steps: summary.steps,
    active_calories_kcal: summary.active_calories_kcal,
    total_calories_kcal: summary.total_calories_kcal,
    exercise_minutes: summary.exercise_minutes,
    observed_at: summary.observed_at.toISOString(),
    created_at: summary.created_at.toISOString(),
    updated_at: summary.updated_at.toISOString()
  };
}

function activityRecordData(
  userId: number,
  sourceDeviceId: string,
  recordType: PrismaActivityRecordType,
  record: ParsedActivityRecord
) {
  return {
    user_id: userId,
    source_device_id: sourceDeviceId,
    record_type: recordType,
    external_id: record.externalId,
    data_origin: record.dataOrigin,
    client_record_id: record.clientRecordId,
    client_record_version: record.clientRecordVersion,
    source_updated_at: record.sourceUpdatedAt,
    start_time: record.startTime,
    end_time: record.endTime,
    start_zone_offset_seconds: record.startZoneOffsetSeconds,
    end_zone_offset_seconds: record.endZoneOffsetSeconds,
    local_date: record.localDate,
    step_count: record.stepCount,
    energy_kcal: record.energyKcal,
    weight_grams: record.weightGrams,
    exercise_type: record.exerciseType,
    title: record.title,
    notes: record.notes,
    recording_method: record.recordingMethod,
    device_type: record.deviceType,
    device_manufacturer: record.deviceManufacturer,
    device_model: record.deviceModel
  };
}

function daySummaryData(userId: number, sourceDeviceId: string, summary: ParsedActivityDaySummary) {
  return {
    user_id: userId,
    source_device_id: sourceDeviceId,
    local_date: summary.localDate,
    steps: summary.steps,
    active_calories_kcal: summary.activeCaloriesKcal,
    total_calories_kcal: summary.totalCaloriesKcal,
    exercise_minutes: summary.exerciseMinutes,
    observed_at: summary.observedAt
  };
}

async function findSourceRecord(
  tx: MutationDatabase,
  userId: number,
  sourceDeviceId: string,
  recordType: PrismaActivityRecordType,
  externalId: string
) {
  return tx.activityRecord.findUnique({
    where: {
      user_id_source_device_id_record_type_external_id: {
        user_id: userId,
        source_device_id: sourceDeviceId,
        record_type: recordType,
        external_id: externalId
      }
    }
  });
}

/** Return activity aggregates and source records for an inclusive account-local date range. */
router.get('/days', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const timeZone = typeof user.timezone === 'string' ? user.timezone : 'UTC';
  let range;
  try {
    /** Reconcile one Health Connect change-token page and advance its device checkpoint atomically. */
    range = parseActivityRange(req.query as Record<string, unknown>, timeZone);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Invalid date range' });
  }

  try {
    const [summaries, records] = await Promise.all([
      prisma.activityDaySummary.findMany({
        where: { user_id: user.id, local_date: { gte: range.start, lte: range.end } },
        orderBy: { local_date: 'asc' }
      }),
      prisma.activityRecord.findMany({
        where: { user_id: user.id, local_date: { gte: range.start, lte: range.end } },
        orderBy: [{ local_date: 'asc' }, { start_time: 'asc' }, { id: 'asc' }]
      })
    ]);
    const summariesByDate = new Map(summaries.map((summary) => [toDateKey(summary.local_date), summary]));
    const recordsByDate = new Map<string, typeof records>();
    for (const record of records) {
      const key = toDateKey(record.local_date);
      const existing = recordsByDate.get(key) ?? [];
      /** Reconcile one Health Connect change-token page and advance its device checkpoint atomically. */
      existing.push(record);
      /** Reconcile one Health Connect change-token page and advance its device checkpoint atomically. */
      recordsByDate.set(key, existing);
    }

    return res.json({
      start_date: range.dateKeys[0],
      end_date: range.dateKeys[range.dateKeys.length - 1],
      days: range.dateKeys.map((localDate) => ({
        local_date: localDate,
        summary: summariesByDate.has(localDate)
          ? serializeDaySummary(summariesByDate.get(localDate) as StoredDaySummary)
          : null,
        records: (recordsByDate.get(localDate) ?? []).map((record) =>
          serializeActivityRecord(record as StoredActivityRecord)
        )
      }))
    });
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
});

/** Reconcile one Health Connect change-token page and advance its device checkpoint atomically. */
router.post('/health-connect/sync', async (req, res) => {
  const startedAt = Date.now();
  const recordOutcome = (statusCode: number) => diagnosticsRegistry.recordOperation(
    'health_connect_ingestion',
    diagnosticOperationOutcomeForStatus(statusCode),
    Date.now() - startedAt
  );
  const user = getAuthenticatedUser(req);
  const sourceDeviceId = res.locals.mobileDeviceId as string | undefined;
  if (!sourceDeviceId) {
    /** Reconcile one Health Connect change-token page and advance its device checkpoint atomically. */
    recordOutcome(403);
    return res.status(403).json({ message: 'Health Connect sync requires an authenticated mobile device' });
  }

  const operationId = parseClientOperationId(
    req.get?.('x-client-operation-id') ?? req.headers?.['x-client-operation-id']
  );
  if (operationId === null) {
    /** Reconcile one Health Connect change-token page and advance its device checkpoint atomically. */
    recordOutcome(400);
    return res.status(400).json({ message: 'Invalid x-client-operation-id' });
  }
  if (operationId === undefined) {
    /** Reconcile one Health Connect change-token page and advance its device checkpoint atomically. */
    recordOutcome(400);
    return res.status(400).json({ message: 'x-client-operation-id is required' });
  }

  let parsed;
  try {
    /** Reconcile one Health Connect change-token page and advance its device checkpoint atomically. */
    parsed = parseHealthConnectSyncBody(
      req.body,
      typeof user.timezone === 'string' ? user.timezone : 'UTC'
    );
  } catch (error) {
    /** Reconcile one Health Connect change-token page and advance its device checkpoint atomically. */
    recordOutcome(400);
    const message = error instanceof Error ? error.message : 'Invalid sync request';
    return res.status(400).json({
      message,
      ...(message.includes('weight_grams') ? { code: 'WEIGHT_OUT_OF_RANGE', retryable: false } : {})
    });
  }

  const recordType = parsed.recordType as PrismaActivityRecordType;
  try {
    const result = await executeIdempotentMutation<unknown>({
      userId: user.id,
      operationId,
      operationKind: `activity.health_connect.sync.${parsed.recordType}`,
      requestPayload: req.body,
      mutate: async (tx, claimedOperationId) => {
        const stateKey = {
          user_id: user.id,
          source_device_id: sourceDeviceId,
          record_type: recordType
        };
        const currentState = await tx.healthConnectSyncState.findUnique({
          where: { user_id_source_device_id_record_type: stateKey }
        });
        if (
          parsed.syncMode === 'incremental' &&
          (currentState?.changes_token ?? null) !== parsed.previousChangesToken
        ) {
          return {
            status: 409,
            body: {
              message: 'Health Connect changes token does not match the server checkpoint',
              code: 'HEALTH_CONNECT_TOKEN_MISMATCH',
              retryable: false
            }
          };
        }

        let deleted = 0;
        let resetDeleted = 0;
        let upserted = 0;
        let staleIgnored = 0;
        let tombstonedIgnored = 0;
        let summariesUpserted = 0;
        let summariesStaleIgnored = 0;

        if (parsed.replaceWindow) {
          const replacementWhere = {
            ...stateKey,
            local_date: {
              gte: parsed.replaceWindow.start,
              lte: parsed.replaceWindow.end
            }
          };
          const replacedRecords = await tx.activityRecord.findMany({
            where: replacementWhere,
            select: { external_id: true }
          });
          const replacementDeletion = await tx.activityRecord.deleteMany({ where: replacementWhere });
          resetDeleted = replacementDeletion.count;
          // A reset is authoritative for the current Health Connect store. Old deletion ids
          // must not prevent records in the fresh snapshot from being restored.
          await tx.healthConnectTombstone.deleteMany({ where: stateKey });
          for (const replacedRecord of replacedRecords) {
            await recordSyncChange({
              tx,
              userId: user.id,
              entityType: 'activity_record',
              entityId: `${sourceDeviceId}:${recordType}:${replacedRecord.external_id}`,
              action: 'delete',
              operationId: claimedOperationId
            });
          }
        }

        for (const externalId of parsed.deletedRecordIds) {
          await tx.healthConnectTombstone.upsert({
            where: {
              user_id_source_device_id_record_type_external_id: {
                ...stateKey,
                external_id: externalId
              }
            },
            update: {},
            create: { ...stateKey, external_id: externalId }
          });
          const deletion = await tx.activityRecord.deleteMany({
            where: { ...stateKey, external_id: externalId }
          });
          deleted += deletion.count;
          await recordSyncChange({
            tx,
            userId: user.id,
            entityType: 'activity_record',
            entityId: `${sourceDeviceId}:${recordType}:${externalId}`,
            action: 'delete',
            operationId: claimedOperationId
          });
        }

        for (const sourceRecord of parsed.upserts) {
          const tombstone = await tx.healthConnectTombstone.findUnique({
            where: {
              user_id_source_device_id_record_type_external_id: {
                ...stateKey,
                external_id: sourceRecord.externalId
              }
            }
          });
          if (tombstone) {
            tombstonedIgnored += 1;
            continue;
          }

          const existing = await findSourceRecord(
            tx,
            user.id,
            sourceDeviceId,
            recordType,
            sourceRecord.externalId
          );
          if (existing && existing.source_updated_at >= sourceRecord.sourceUpdatedAt) {
            staleIgnored += 1;
            continue;
          }
          const data = activityRecordData(user.id, sourceDeviceId, recordType, sourceRecord);
          const saved = existing
            ? await tx.activityRecord.update({ where: { id: existing.id }, data })
            : await tx.activityRecord.create({ data });
          upserted += 1;
          await recordSyncChange({
            tx,
            userId: user.id,
            entityType: 'activity_record',
            entityId: `${sourceDeviceId}:${recordType}:${sourceRecord.externalId}`,
            action: 'upsert',
            operationId: claimedOperationId,
            payload: serializeActivityRecord(saved as StoredActivityRecord)
          });
        }

        for (const summary of parsed.daySummaries) {
          const where = { user_id_local_date: { user_id: user.id, local_date: summary.localDate } };
          const existing = await tx.activityDaySummary.findUnique({ where });
          if (existing && existing.observed_at >= summary.observedAt) {
            summariesStaleIgnored += 1;
            continue;
          }
          const data = daySummaryData(user.id, sourceDeviceId, summary);
          const saved = existing
            ? await tx.activityDaySummary.update({ where, data })
            : await tx.activityDaySummary.create({ data });
          summariesUpserted += 1;
          await recordSyncChange({
            tx,
            userId: user.id,
            entityType: 'activity_day',
            entityId: toDateKey(summary.localDate),
            action: 'upsert',
            operationId: claimedOperationId,
            payload: serializeDaySummary(saved as StoredDaySummary)
          });
        }

        const now = new Date();
        await tx.healthConnectSyncState.upsert({
          where: { user_id_source_device_id_record_type: stateKey },
          update: { changes_token: parsed.nextChangesToken, last_synced_at: now },
          create: {
            ...stateKey,
            changes_token: parsed.nextChangesToken,
            last_synced_at: now
          }
        });

        return {
          status: 200,
          body: {
            record_type: parsed.recordType,
            upserted,
            deleted,
            reset_deleted: resetDeleted,
            stale_ignored: staleIgnored,
            tombstoned_ignored: tombstonedIgnored,
            day_summaries_upserted: summariesUpserted,
            day_summaries_stale_ignored: summariesStaleIgnored,
            checkpoint_advanced: true
          }
        };
      }
    });
    /** Reconcile one Health Connect change-token page and advance its device checkpoint atomically. */
    recordOutcome(result.status);
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof ClientOperationConflictError) {
      /** Reconcile one Health Connect change-token page and advance its device checkpoint atomically. */
      recordOutcome(409);
      return res.status(409).json({
        message: error.message,
        code: error.code,
        retryable: error.code === 'OPERATION_IN_PROGRESS'
      });
    }
    /** Reconcile one Health Connect change-token page and advance its device checkpoint atomically. */
    recordOutcome(500);
    return res.status(500).json({ message: 'Server error' });
  }
});

export default router;
