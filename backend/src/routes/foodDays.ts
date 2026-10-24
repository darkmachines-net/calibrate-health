/** @file Local-day completion, saved calorie comparisons, tracking pauses, and resume endpoints. */

import express from 'express';
import prisma from '../config/database';
import { MS_PER_DAY, getSafeUtcTodayDateOnlyInTimeZone, parseLocalDateOnly } from '../utils/date';
import {
  ClientOperationConflictError,
  executeIdempotentMutation,
  parseClientOperationId,
  recordSyncChange
} from '../services/clientOperations';
import {
  type FoodDayStatus,
  formatDateKey,
  getActiveFoodTrackingPause,
  getEffectiveFoodDay,
  getEffectiveFoodDayRange,
  isFoodDayStatus,
  resumeFoodTracking,
  serializeFoodDayStatus,
  startFoodTrackingPause,
  updateFoodTrackingPauseExpectation
} from '../services/foodTracking';
import { resolveInactiveReminderNotificationsForUser } from '../services/inAppNotifications';
import { getAuthenticatedUser, requireAuthenticatedUser } from '../middleware/authenticatedUser';
import { captureFoodDayComparison, readFoodDayComparison } from '../services/foodDayComparison';
import { lockCaloriePlanningInputs } from '../services/caloriePlanningLock';
import { observeFoodActivityPlan } from '../services/dailyCaloriePlans';

const router = express.Router();
router.use(requireAuthenticatedUser);

function parseRequestedDate(value: unknown): { ok: true; dateValue: Date; dateKey: string } | { ok: false } {
  if (typeof value !== 'string') return { ok: false };
  try {
    const dateValue = parseLocalDateOnly(value);
    return { ok: true, dateValue, dateKey: formatDateKey(dateValue) };
  } catch {
    return { ok: false };
  }
}

function parseNullableDate(value: unknown): { ok: true; dateValue: Date | null } | { ok: false } {
  if (value === null) return { ok: true, dateValue: null };
  const parsed = parseRequestedDate(value);
  return parsed.ok ? { ok: true, dateValue: parsed.dateValue } : { ok: false };
}

const MONTH_QUERY_PATTERN = /^(\d{4})-(\d{2})$/;
const MAX_RANGE_QUERY_DAYS = 366;

type ParsedDateRange =
  | {
      ok: true;
      startDateValue: Date;
      endDateValue: Date;
      startDateKey: string;
      endDateKey: string;
    }
  | { ok: false; message: string };

function countInclusiveUtcDays(startDateValue: Date, endDateValue: Date): number {
  return Math.floor((endDateValue.getTime() - startDateValue.getTime()) / MS_PER_DAY) + 1;
}

function parseRequestedRange(query: Record<string, unknown>): ParsedDateRange {
  const monthParam = typeof query.month === 'string' ? query.month : undefined;
  const startParam =
    typeof query.start === 'string'
      ? query.start
      : typeof query.start_date === 'string'
        ? query.start_date
        : undefined;
  const endParam =
    typeof query.end === 'string'
      ? query.end
      : typeof query.end_date === 'string'
        ? query.end_date
        : undefined;

  if (monthParam) {
    if (startParam || endParam) return { ok: false, message: 'Provide either month or start/end' };
    const match = monthParam.match(MONTH_QUERY_PATTERN);
    if (!match) return { ok: false, message: 'Invalid month' };
    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    if (!Number.isInteger(year) || month < 1 || month > 12) {
      return { ok: false, message: 'Invalid month' };
    }
    const startDateValue = parseLocalDateOnly(`${match[1]}-${match[2]}-01`);
    const endDateValue = new Date(Date.UTC(year, month, 0));
    return {
      ok: true,
      startDateValue,
      endDateValue,
      startDateKey: formatDateKey(startDateValue),
      endDateKey: formatDateKey(endDateValue)
    };
  }
  if (!startParam || !endParam) return { ok: false, message: 'Provide start and end dates' };
  const start = parseRequestedDate(startParam);
  const end = parseRequestedDate(endParam);
  if (!start.ok || !end.ok || start.dateValue > end.dateValue) {
    return { ok: false, message: 'Invalid date range' };
  }
  if (countInclusiveUtcDays(start.dateValue, end.dateValue) > MAX_RANGE_QUERY_DAYS) {
    return { ok: false, message: 'Date range too large' };
  }
  return {
    ok: true,
    startDateValue: start.dateValue,
    endDateValue: end.dateValue,
    startDateKey: start.dateKey,
    endDateKey: end.dateKey
  };
}

function parseOperationId(req: express.Request): string | null | undefined {
  return parseClientOperationId(req.get?.('x-client-operation-id') ?? req.headers?.['x-client-operation-id']);
}

function sendMutationError(res: express.Response, error: unknown): express.Response {
  if (error instanceof ClientOperationConflictError) {
    return res.status(409).json({
      message: error.message,
      code: error.code,
      retryable: error.code === 'OPERATION_IN_PROGRESS'
    });
  }
  if (error instanceof Error && error.message === 'ACTIVE_PAUSE_EXISTS') {
    return res.status(409).json({ message: 'Tracking is already paused', code: 'ACTIVE_PAUSE_EXISTS' });
  }
  if (error instanceof Error && error.message === 'NO_ACTIVE_PAUSE') {
    return res.status(409).json({ message: 'Tracking is not paused', code: 'NO_ACTIVE_PAUSE' });
  }
  if (error instanceof Error && error.message === 'INVALID_RESUME_DATE') {
    return res.status(400).json({ message: 'Resume date cannot be before the pause start' });
  }
  if (error instanceof Error && error.message === 'INVALID_EXPECTED_RESUME_DATE') {
    return res.status(400).json({ message: 'Expected resume date must be after the pause start' });
  }
  return res.status(500).json({ message: 'Server error' });
}

router.get('/range', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const range = parseRequestedRange(req.query as Record<string, unknown>);
  if (!range.ok) return res.status(400).json({ message: range.message });
  try {
    const days = await getEffectiveFoodDayRange(user.id, range.startDateValue, range.endDateValue);
    if (!days) return res.status(404).json({ message: 'User not found' });
    return res.json({ start_date: range.startDateKey, end_date: range.endDateKey, days });
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/pause', async (req, res) => {
  const user = getAuthenticatedUser(req);
  try {
    const pause = await getActiveFoodTrackingPause(user.id);
    if (!pause) return res.status(404).json({ message: 'User not found' });
    return res.json({ pause });
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const dateParam =
    typeof req.query.date === 'string'
      ? req.query.date
      : typeof req.query.local_date === 'string'
        ? req.query.local_date
        : undefined;
  const parsed = parseRequestedDate(dateParam);
  if (!parsed.ok) return res.status(400).json({ message: 'Invalid date' });
  try {
    const day = await getEffectiveFoodDay(user.id, parsed.dateValue);
    if (!day) return res.status(404).json({ message: 'User not found' });
    return res.json(day);
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/', async (req, res) => {
  const user = getAuthenticatedUser(req);
  if (typeof req.body !== 'object' || req.body === null) {
    return res.status(400).json({ message: 'Invalid request body' });
  }
  const { date, local_date, status: rawStatus, is_complete } = req.body as Record<string, unknown>;
  const parsed = parseRequestedDate(date ?? local_date);
  if (!parsed.ok) return res.status(400).json({ message: 'Invalid date' });

  let status: FoodDayStatus;
  let operationKind: string;
  if (rawStatus !== undefined) {
    if (!isFoodDayStatus(rawStatus) || rawStatus === 'PAUSED') {
      return res.status(400).json({ message: 'Invalid status' });
    }
    status = rawStatus;
    operationKind = 'food_log_day.set_status';
  } else {
    if (typeof is_complete !== 'boolean') {
      return res.status(400).json({ message: 'Invalid is_complete' });
    }
    status = is_complete ? 'COMPLETE' : 'OPEN';
    operationKind = 'food_log_day.set_complete';
  }

  const operationId = parseOperationId(req);
  if (operationId === null) return res.status(400).json({ message: 'Invalid x-client-operation-id' });
  try {
    const result = await executeIdempotentMutation({
      userId: user.id,
      operationId,
      operationKind,
      requestPayload: req.body,
      mutate: async (tx, claimedOperationId) => {
        await lockCaloriePlanningInputs(tx, user.id);
        const completedAt = status === 'COMPLETE' ? new Date() : null;
        if (!completedAt) await observeFoodActivityPlan(tx, user.id, [parsed.dateValue]);
        let updated = await tx.foodLogDay.upsert({
          where: { user_id_local_date: { user_id: user.id, local_date: parsed.dateValue } },
          update: { status, origin: 'USER', completed_at: completedAt },
          create: {
            user_id: user.id,
            local_date: parsed.dateValue,
            status,
            origin: 'USER',
            completed_at: completedAt
          }
        });
        if (completedAt) updated = await captureFoodDayComparison(tx, updated, completedAt);
        const body = { ...serializeFoodDayStatus({
          date: updated.local_date,
          status: updated.status as FoodDayStatus,
          origin: updated.origin,
          completedAt: updated.completed_at,
          updatedAt: updated.updated_at
        }), calorie_comparison: await readFoodDayComparison(tx, updated) };
        await recordSyncChange({
          tx,
          userId: user.id,
          entityType: 'food_log_day',
          entityId: parsed.dateKey,
          action: 'upsert',
          operationId: claimedOperationId,
          payload: body
        });
        return { status: 200, body };
      }
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return sendMutationError(res, error);
  }
});

router.post('/pause', async (req, res) => {
  const user = getAuthenticatedUser(req);
  if (typeof req.body !== 'object' || req.body === null) {
    return res.status(400).json({ message: 'Invalid request body' });
  }
  const body = req.body as Record<string, unknown>;
  const startsOn = parseRequestedDate(body.starts_on ?? body.date);
  const expected = parseNullableDate(body.expected_resume_on ?? null);
  if (!startsOn.ok) return res.status(400).json({ message: 'Invalid starts_on' });
  if (!expected.ok || (expected.dateValue !== null && expected.dateValue <= startsOn.dateValue)) {
    return res.status(400).json({ message: 'Expected resume date must be after the pause start' });
  }
  const operationId = parseOperationId(req);
  if (operationId === null) return res.status(400).json({ message: 'Invalid x-client-operation-id' });
  const now = new Date();
  try {
    const result = await executeIdempotentMutation({
      userId: user.id,
      operationId,
      operationKind: 'food_tracking_pause.start',
      requestPayload: req.body,
      mutate: async (tx, claimedOperationId) => {
        const pause = await startFoodTrackingPause({
          tx,
          userId: user.id,
          startsOn: startsOn.dateValue,
          expectedResumeOn: expected.dateValue,
          now,
          operationId: claimedOperationId
        });
        return { status: 201, body: { pause } };
      }
    });
    const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: { timezone: true } });
    if (dbUser) {
      await resolveInactiveReminderNotificationsForUser({ userId: user.id, timeZone: dbUser.timezone, now });
    }
    return res.status(result.status).json(result.body);
  } catch (error) {
    return sendMutationError(res, error);
  }
});

router.patch('/pause', async (req, res) => {
  const user = getAuthenticatedUser(req);
  if (typeof req.body !== 'object' || req.body === null || !('expected_resume_on' in req.body)) {
    return res.status(400).json({ message: 'Invalid request body' });
  }
  const expected = parseNullableDate((req.body as Record<string, unknown>).expected_resume_on);
  if (!expected.ok) return res.status(400).json({ message: 'Invalid expected_resume_on' });
  const operationId = parseOperationId(req);
  if (operationId === null) return res.status(400).json({ message: 'Invalid x-client-operation-id' });
  const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: { timezone: true } });
  if (!dbUser) return res.status(404).json({ message: 'User not found' });
  const today = getSafeUtcTodayDateOnlyInTimeZone(dbUser.timezone);
  try {
    const result = await executeIdempotentMutation({
      userId: user.id,
      operationId,
      operationKind: 'food_tracking_pause.set_expected_resume',
      requestPayload: req.body,
      mutate: async (tx, claimedOperationId) => {
        const pause = await updateFoodTrackingPauseExpectation({
          tx,
          userId: user.id,
          expectedResumeOn: expected.dateValue,
          today,
          operationId: claimedOperationId
        });
        return { status: 200, body: { pause } };
      }
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return sendMutationError(res, error);
  }
});

router.post('/resume', async (req, res) => {
  const user = getAuthenticatedUser(req);
  if (typeof req.body !== 'object' || req.body === null) {
    return res.status(400).json({ message: 'Invalid request body' });
  }
  const resumedOn = parseRequestedDate((req.body as Record<string, unknown>).resumed_on ?? (req.body as Record<string, unknown>).date);
  if (!resumedOn.ok) return res.status(400).json({ message: 'Invalid resumed_on' });
  const operationId = parseOperationId(req);
  if (operationId === null) return res.status(400).json({ message: 'Invalid x-client-operation-id' });
  const now = new Date();
  try {
    const result = await executeIdempotentMutation({
      userId: user.id,
      operationId,
      operationKind: 'food_tracking_pause.resume',
      requestPayload: req.body,
      mutate: async (tx, claimedOperationId) => {
        const resumed = await resumeFoodTracking({
          tx,
          userId: user.id,
          resumedOn: resumedOn.dateValue,
          now,
          operationId: claimedOperationId
        });
        return { status: 200, body: resumed };
      }
    });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return sendMutationError(res, error);
  }
});

export default router;
