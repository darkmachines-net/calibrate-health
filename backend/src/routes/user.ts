/** @file Account profile, preferences, avatar, password, connected apps, export, and deletion endpoints. */

import { verifyLocalPassword } from '../services/credentialVerification';
import express from 'express';
import prisma from '../config/database';
import bcrypt from 'bcryptjs';
import { isHeightUnit, isWeightUnit } from '../utils/units';
import { ActivityLevel, HeightUnit, Prisma, Sex, WeightUnit } from '@prisma/client';
import { isActivityLevel, isSex } from '../utils/profile';
import { isValidIanaTimeZone } from '../utils/date';
import { calorieSummaryWire } from '../services/caloriePlanning';
import { observeCurrentCaloriePlan, invalidateDailyPlanTimezone } from '../services/dailyCaloriePlans';
import { lockCaloriePlanningInputs } from '../services/caloriePlanningLock';
import { markCurrentCaloriePlanForReviewIfUnsafe } from '../services/caloriePlanReview';
import { evaluateCalorieProfileEligibility, isPolicyHeight, normalizeDateOfBirth } from '../../../shared/caloriePolicy';
import { resolveHeightMmUpdate } from '../utils/height';
import { isSupportedLanguage, type SupportedLanguage } from '../utils/language';
import { MAX_PROFILE_IMAGE_BYTES, parseBase64DataUrl } from '../utils/profileImage';
import { serializeUserForClient, USER_CLIENT_SELECT } from '../utils/userSerialization';
import { validatePasswordCredential } from '../utils/authCredentials';
import { revokeOtherMobileSessionsForUser } from '../services/mobileAuth';
import { revokeOtherBrowserSessionsForUser } from '../services/browserSessions';
import { deleteAccountData, exportAccountData } from '../services/accountLifecycle';
import { formatDateKey, getTrackingStartDate } from '../services/foodTracking';
import {
  ClientOperationConflictError,
  executeIdempotentMutation,
  parseClientOperationId,
  recordSyncChange
} from '../services/clientOperations';
import { logSafeOperationalError } from '../observability';
import { clearSessionCookie } from '../utils/sessionCookie';
import { getAuthenticatedUser, requireAuthenticatedUser } from '../middleware/authenticatedUser';
import { parseLocalWallClockTime } from '../services/reminderSchedule';
import { mcpOAuthService } from '../services/mcpOAuth';

/**
 * Authenticated user account routes (profile, preferences, password, avatar).
 *
 * These endpoints keep the session user payload aligned with the latest stored profile fields.
 */
const router = express.Router();

type PasswordChangeParseResult =
  | { ok: true; currentPassword: string; newPassword: string }
  | { ok: false; message: string };

/**
 * Validate and normalize the password change request payload.
 *
 * This performs lightweight shape/length checks; the current password is verified
 * against the stored hash in the route handler.
 */
const parsePasswordChangePayload = (body: unknown): PasswordChangeParseResult => {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'Invalid request body' };
  }

  const record = body as Record<string, unknown>;
  const currentPassword = record.current_password;
  const newPassword = record.new_password;

  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    return { ok: false, message: 'Current password is required' };
  }
  if (typeof newPassword !== 'string') {
    return { ok: false, message: 'New password is required' };
  }
  const newPasswordError = validatePasswordCredential(newPassword, 'New password');
  if (newPasswordError) return { ok: false, message: newPasswordError };

  return { ok: true, currentPassword, newPassword };
};

const parseCurrentPassword = (body: unknown): string | null => {
  if (!body || typeof body !== 'object') return null;
  const currentPassword = (body as Record<string, unknown>).current_password;
  return typeof currentPassword === 'string' && currentPassword.length > 0 ? currentPassword : null;
};

const destroyRequestSession = (req: express.Request): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!req.session) {
      resolve();
      return;
    }
    req.session.destroy((error) => error ? reject(error) : resolve());
  });

router.use(requireAuthenticatedUser);

router.get('/connected-apps', async (req, res) => {
  const user = getAuthenticatedUser(req);
  try {
    const connections = await mcpOAuthService.listConnectionsForUser(user.id);
    res.setHeader('cache-control', 'no-store');
    res.json({
      connections: connections.map((connection) => ({
        id: connection.id,
        client_id: connection.clientId,
        client_name: connection.clientName,
        scopes: connection.scopes,
        resource: connection.resource,
        created_at: connection.createdAt,
        last_used_at: connection.lastUsedAt,
        expires_at: connection.expiresAt
      }))
    });
  } catch (error) {
    logSafeOperationalError('mcp.connections.list', error, res.locals?.requestId);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/connected-apps/:connectionId', async (req, res) => {
  const user = getAuthenticatedUser(req);
  try {
    const revoked = await mcpOAuthService.revokeConnectionForUser(user.id, req.params.connectionId);
    if (!revoked) {
      res.status(404).json({ message: 'Connected app not found' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    logSafeOperationalError('mcp.connections.revoke', error, res.locals?.requestId);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/me', async (req, res) => {
  const user = getAuthenticatedUser(req);
  try {
    const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: USER_CLIENT_SELECT });
    if (!dbUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ user: serializeUserForClient(dbUser) });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/tracking-history', async (req, res) => {
  const user = getAuthenticatedUser(req);
  try {
    const trackingStart = await getTrackingStartDate(user.id);
    if (!trackingStart) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.json({ tracking_start_date: formatDateKey(trackingStart.date) });
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/profile-image', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const dataUrl = (req.body as { data_url?: unknown } | undefined)?.data_url;

  if (typeof dataUrl !== 'string' || dataUrl.trim().length === 0) {
    return res.status(400).json({ message: 'Missing data_url' });
  }

  const parsed = parseBase64DataUrl(dataUrl);
  if (!parsed) {
    return res.status(400).json({ message: 'Invalid profile image payload' });
  }

  if (parsed.bytes.byteLength > MAX_PROFILE_IMAGE_BYTES) {
    return res.status(413).json({ message: 'Profile image is too large' });
  }

  try {
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        profile_image: parsed.bytes,
        profile_image_mime_type: parsed.mimeType
      },
      select: USER_CLIENT_SELECT
    });

    res.json({ user: serializeUserForClient(updatedUser) });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/profile-image', async (req, res) => {
  const user = getAuthenticatedUser(req);

  try {
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        profile_image: null,
        profile_image_mime_type: null
      },
      select: USER_CLIENT_SELECT
    });

    res.json({ user: serializeUserForClient(updatedUser) });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/password', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const parsed = parsePasswordChangePayload(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ message: parsed.message });
  }

  if (parsed.currentPassword === parsed.newPassword) {
    return res.status(400).json({ message: 'New password must be different from current password' });
  }

  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, password_hash: true }
    });
    if (!dbUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isMatch = await verifyLocalPassword(parsed.currentPassword, dbUser.password_hash);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    const password_hash = await bcrypt.hash(parsed.newPassword, 10);
    const revokedAt = new Date();
    await prisma.$transaction([
      prisma.user.update({
        where: { id: dbUser.id },
        data: { password_hash }
      }),
      prisma.mcpOAuthGrant.updateMany({
        where: { user_id: dbUser.id, revoked_at: null },
        data: { revoked_at: revokedAt }
      }),
      prisma.mcpOAuthAuthorizationCode.deleteMany({
        where: { user_id: dbUser.id }
      })
    ]);
    await Promise.all([
      revokeOtherMobileSessionsForUser(dbUser.id, res.locals.mobileAuthSessionId),
      revokeOtherBrowserSessionsForUser(dbUser.id, req.sessionID)
    ]);

    res.json({ message: 'Password updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/account/export', async (req, res) => {
  const user = getAuthenticatedUser(req);
  try {
    const accountExport = await exportAccountData(user.id);
    if (!accountExport) {
      return res.status(404).json({ message: 'User not found' });
    }

    const exportDate = accountExport.exported_at.slice(0, 10);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-disposition', `attachment; filename="calibrate-account-export-${exportDate}.json"`);
    res.json(accountExport);
  } catch (error) {
    logSafeOperationalError('account.export', error, res.locals?.requestId);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/account', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const currentPassword = parseCurrentPassword(req.body);
  if (!currentPassword) {
    return res.status(400).json({ message: 'Current password is required' });
  }

  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { password_hash: true }
    });
    if (!dbUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    const passwordMatches = await verifyLocalPassword(currentPassword, dbUser.password_hash);
    if (!passwordMatches) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    const deleted = await deleteAccountData(user.id);
    if (!deleted) {
      return res.status(404).json({ message: 'User not found' });
    }

    try {
      await destroyRequestSession(req);
    } catch (error) {
      // The user row and linked sessions are already gone; clearing the browser cookie completes logout.
      logSafeOperationalError('account.session_cleanup', error, res.locals?.requestId, console.warn);
    }
    clearSessionCookie(res);
    res.status(204).send();
  } catch (error) {
    logSafeOperationalError('account.delete', error, res.locals?.requestId);
    res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/preferences', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const {
    weight_unit,
    height_unit,
    language,
    reminder_log_weight_enabled,
    reminder_log_food_enabled,
    reminder_log_weight_time,
    reminder_log_food_time,
    reminder_quiet_hours_start,
    reminder_quiet_hours_end,
    haptics_enabled
  } = req.body as {
    weight_unit?: unknown;
    height_unit?: unknown;
    language?: unknown;
    reminder_log_weight_enabled?: unknown;
    reminder_log_food_enabled?: unknown;
    reminder_log_weight_time?: unknown;
    reminder_log_food_time?: unknown;
    reminder_quiet_hours_start?: unknown;
    reminder_quiet_hours_end?: unknown;
    haptics_enabled?: unknown;
  };

  if (
    weight_unit === undefined &&
    height_unit === undefined &&
    language === undefined &&
    reminder_log_weight_enabled === undefined &&
    reminder_log_food_enabled === undefined &&
    reminder_log_weight_time === undefined &&
    reminder_log_food_time === undefined &&
    reminder_quiet_hours_start === undefined &&
    reminder_quiet_hours_end === undefined &&
    haptics_enabled === undefined
  ) {
    return res.status(400).json({ message: 'No fields to update' });
  }

  const updateData: Partial<{
    weight_unit: WeightUnit;
    height_unit: HeightUnit;
    language: SupportedLanguage;
    reminder_log_weight_enabled: boolean;
    reminder_log_food_enabled: boolean;
    reminder_log_weight_minute: number;
    reminder_log_food_minute: number;
    reminder_quiet_hours_start_minute: number | null;
    reminder_quiet_hours_end_minute: number | null;
    haptics_enabled: boolean;
  }> = {};

  if (weight_unit !== undefined) {
    if (!isWeightUnit(weight_unit)) {
      return res.status(400).json({ message: 'Invalid weight_unit' });
    }
    updateData.weight_unit = weight_unit as WeightUnit;
  }

  if (height_unit !== undefined) {
    if (!isHeightUnit(height_unit)) {
      return res.status(400).json({ message: 'Invalid height_unit' });
    }
    updateData.height_unit = height_unit as HeightUnit;
  }

  if (language !== undefined) {
    if (!isSupportedLanguage(language)) {
      return res.status(400).json({ message: 'Invalid language' });
    }
    updateData.language = language;
  }

  if (reminder_log_weight_enabled !== undefined) {
    if (typeof reminder_log_weight_enabled !== 'boolean') {
      return res.status(400).json({ message: 'Invalid reminder_log_weight_enabled' });
    }
    updateData.reminder_log_weight_enabled = reminder_log_weight_enabled;
  }

  if (reminder_log_food_enabled !== undefined) {
    if (typeof reminder_log_food_enabled !== 'boolean') {
      return res.status(400).json({ message: 'Invalid reminder_log_food_enabled' });
    }
    updateData.reminder_log_food_enabled = reminder_log_food_enabled;
  }

  if (reminder_log_weight_time !== undefined) {
    const minute = parseLocalWallClockTime(reminder_log_weight_time);
    if (minute === null) return res.status(400).json({ message: 'Invalid reminder_log_weight_time' });
    updateData.reminder_log_weight_minute = minute;
  }

  if (reminder_log_food_time !== undefined) {
    const minute = parseLocalWallClockTime(reminder_log_food_time);
    if (minute === null) return res.status(400).json({ message: 'Invalid reminder_log_food_time' });
    updateData.reminder_log_food_minute = minute;
  }

  const quietStartProvided = reminder_quiet_hours_start !== undefined;
  const quietEndProvided = reminder_quiet_hours_end !== undefined;
  if (quietStartProvided !== quietEndProvided) {
    return res.status(400).json({ message: 'Quiet hours start and end must be updated together' });
  }
  if (quietStartProvided && quietEndProvided) {
    if (reminder_quiet_hours_start === null && reminder_quiet_hours_end === null) {
      updateData.reminder_quiet_hours_start_minute = null;
      updateData.reminder_quiet_hours_end_minute = null;
    } else {
      const startMinute = parseLocalWallClockTime(reminder_quiet_hours_start);
      const endMinute = parseLocalWallClockTime(reminder_quiet_hours_end);
      if (startMinute === null || endMinute === null || startMinute === endMinute) {
        return res.status(400).json({ message: 'Invalid reminder quiet hours' });
      }
      updateData.reminder_quiet_hours_start_minute = startMinute;
      updateData.reminder_quiet_hours_end_minute = endMinute;
    }
  }

  if (haptics_enabled !== undefined) {
    if (typeof haptics_enabled !== 'boolean') {
      return res.status(400).json({ message: 'Invalid haptics_enabled' });
    }
    updateData.haptics_enabled = haptics_enabled;
  }

  try {
    const operationId = parseClientOperationId(
      req.get?.('x-client-operation-id') ?? req.headers?.['x-client-operation-id']
    );
    if (operationId === null) {
      return res.status(400).json({ message: 'Invalid x-client-operation-id' });
    }

    const result = await executeIdempotentMutation<unknown>({
      userId: user.id,
      operationId,
      operationKind: 'user.preferences.update',
      requestPayload: req.body,
      mutate: async (tx, claimedOperationId) => {
        const updatedUser = await tx.user.update({
          where: { id: user.id },
          data: updateData,
          select: USER_CLIENT_SELECT
        });
        const body = { user: serializeUserForClient(updatedUser) };
        await recordSyncChange({
          tx,
          userId: user.id,
          entityType: 'user_preferences',
          entityId: user.id,
          action: 'upsert',
          operationId: claimedOperationId,
          payload: body.user
        });
        return { status: 200, body };
      }
    });

    return res.status(result.status).json(result.body);
  } catch (err) {
    if (err instanceof ClientOperationConflictError) {
      return res.status(409).json({
        message: err.message,
        code: err.code,
        retryable: err.code === 'OPERATION_IN_PROGRESS'
      });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/profile', async (req, res) => {
  const user = getAuthenticatedUser(req);
  try {
    const snapshot = await prisma.$transaction(tx => observeCurrentCaloriePlan(tx, user.id));
    if (!snapshot) return res.status(404).json({ message: 'User not found' });
    const { evaluation } = snapshot;
    return res.json({
      profile: {
        timezone: snapshot.user.timezone,
        date_of_birth: snapshot.user.date_of_birth?.toISOString().slice(0, 10) ?? null,
        sex: snapshot.user.sex,
        height_mm: snapshot.user.height_mm,
        activity_level: snapshot.user.activity_level,
        weight_unit: snapshot.user.weight_unit,
        height_unit: snapshot.user.height_unit
      },
      latest_weight_grams: snapshot.latestWeightGrams,
      goal_daily_deficit: snapshot.goal?.daily_deficit ?? null,
      calorie_target_adjustment: snapshot.effectiveRevision?.target_adjustment_kcal ?? 0,
      calorieSummary: calorieSummaryWire(evaluation)
    });
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
});
router.patch('/profile', async (req, res) => {
  const user = getAuthenticatedUser(req);
  const { timezone, date_of_birth, sex, height_cm, height_mm, height_feet, height_inches, activity_level } = req.body;

  const updateData: Partial<{
    timezone: string;
    date_of_birth: Date | null;
    sex: Sex | null;
    height_mm: number | null;
    activity_level: ActivityLevel | null;
  }> = {};

  // PATCH semantics: omitted fields are left unchanged. For timezone, a provided null/empty string
  // explicitly resets to our default ("UTC").
  if (timezone !== undefined) {
    if (timezone === null || timezone === '') {
      updateData.timezone = 'UTC';
    } else if (isValidIanaTimeZone(timezone)) {
      updateData.timezone = timezone.trim();
    } else {
      return res.status(400).json({ message: 'Invalid timezone' });
    }
  }

  if (date_of_birth !== undefined) {
    if (date_of_birth === null || date_of_birth === '') {
      updateData.date_of_birth = null;
    } else {
      const normalizedDate = normalizeDateOfBirth(date_of_birth);
      if (!normalizedDate || typeof date_of_birth !== 'string') {
        return res.status(400).json({
          message: 'Date of birth must use YYYY-MM-DD.', code: 'INVALID_DATE_OF_BIRTH', retryable: false,
          field_errors: { date_of_birth: ['Enter a valid date in YYYY-MM-DD format.'] }
        });
      }
      updateData.date_of_birth = new Date(`${normalizedDate}T00:00:00.000Z`);
    }
  }

  if (sex !== undefined) {
    if (sex === null || sex === '') {
      updateData.sex = null;
    } else if (isSex(sex)) {
      updateData.sex = sex;
    } else {
      return res.status(400).json({ message: 'Invalid sex' });
    }
  }

  const resolvedHeight = resolveHeightMmUpdate({ height_mm, height_cm, height_feet, height_inches });
  if (resolvedHeight.provided) {
    if (!resolvedHeight.valid || (resolvedHeight.value !== null && !isPolicyHeight(resolvedHeight.value))) {
      return res.status(400).json({
        message: 'Height is outside the supported range.', code: 'PROFILE_HEIGHT_OUT_OF_RANGE', retryable: false,
        field_errors: { height: ['Enter a height within the supported range.'] }
      });
    }
    updateData.height_mm = resolvedHeight.value;
  }

  if (activity_level !== undefined) {
    if (activity_level === null || activity_level === '') {
      updateData.activity_level = null;
    } else if (isActivityLevel(activity_level)) {
      updateData.activity_level = activity_level;
    } else {
      return res.status(400).json({ message: 'Invalid activity_level' });
    }
  }

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ message: 'No fields to update' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      await lockCaloriePlanningInputs(tx, user.id);
      const current = await tx.user.findUnique({
        where: { id: user.id },
        select: { timezone: true, date_of_birth: true }
      });
      if (!current) return { status: 404, body: { message: 'User not found' } };

      const candidateDateOfBirth = updateData.date_of_birth === undefined
        ? current.date_of_birth
        : updateData.date_of_birth;
      const candidateTimezone = updateData.timezone ?? current.timezone;
      if (candidateDateOfBirth) {
        const eligibility = evaluateCalorieProfileEligibility({
          dateOfBirth: candidateDateOfBirth,
          timezone: candidateTimezone
        });
        if (eligibility.reasonCode === 'DATE_OF_BIRTH_IN_FUTURE') {
          return {
            status: 400,
            body: {
              message: 'Date of birth cannot be in the future.', code: 'DATE_OF_BIRTH_IN_FUTURE', retryable: false,
              field_errors: { date_of_birth: ['Date of birth cannot be in the future.'] }
            }
          };
        }
        if (eligibility.reasonCode === 'AGE_OVER_120') {
          return {
            status: 400,
            body: {
              message: 'Age cannot be greater than 120.', code: 'AGE_OUT_OF_RANGE', retryable: false,
              field_errors: { date_of_birth: ['Enter an age no greater than 120.'] }
            }
          };
        }
      }

      await invalidateDailyPlanTimezone(tx, user.id, current.timezone, candidateTimezone, new Date());
      const updatedUser = await tx.user.update({
        where: { id: user.id }, data: updateData, select: USER_CLIENT_SELECT
      });
      await markCurrentCaloriePlanForReviewIfUnsafe(tx, user.id);
      return { status: 200, body: { user: serializeUserForClient(updatedUser) } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      return res.status(409).json({
        message: 'Your profile or calorie plan changed during saving. Refresh and try again.',
        code: 'PROFILE_PLAN_CHANGED', retryable: true
      });
    }
    return res.status(500).json({ message: 'Server error' });
  }
});

export default router;
