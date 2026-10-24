/** @file Bounded background reminder scheduling, eligibility, deduplication, delivery, and resolution. */

import prisma from '../config/database';
import { InAppNotificationType } from '@prisma/client';
import { getSafeUtcTodayDateOnlyInTimeZone } from '../utils/date';
import { parsePositiveInteger } from '../utils/requestParsing';
import { MS_PER_MINUTE } from '../utils/time';
import { CURRENT_ACCOUNT_ACCESS_WHERE } from '../utils/accountAccessSerialization';
import {
    buildReminderInAppDedupeKey,
    getReminderMissingStatusForDate,
    resolveInactiveReminderNotificationsForUser
} from './inAppNotifications';
import { materializeActiveFoodTrackingPauses } from './foodTracking';
import { deliverUserNotification, type InAppNotificationDeliveryRequest } from './notificationDelivery';
import { buildReminderPayload } from './pushNotificationPayloads';
import { DEFAULT_NOTIFICATION_DELIVERY_CHANNELS } from '../../../shared/notificationDelivery';
import { getLocalWallClock, isReminderDue, isWithinQuietHours } from './reminderSchedule';
import {
    diagnosticsRegistry,
    emitDiagnosticEvent,
    resolveObservabilityConfig
} from '../observability';

const DEFAULT_REMINDER_JOB_INTERVAL_MINUTES = 15; // How often to scan for eligible reminders.

let hasLoggedMissingConfig = false;
let isReminderCheckInProgress = false;
const observabilityConfig = resolveObservabilityConfig(process.env);

const resolveJobIntervalMinutes = (env: NodeJS.ProcessEnv = process.env): number => {
    const parsed = parsePositiveInteger(env.REMINDER_JOB_INTERVAL_MINUTES);
    if (!parsed) {
        if (env.REMINDER_JOB_INTERVAL_MINUTES) {
            console.warn(
                `REMINDER_JOB_INTERVAL_MINUTES="${env.REMINDER_JOB_INTERVAL_MINUTES}" is invalid; using ${DEFAULT_REMINDER_JOB_INTERVAL_MINUTES}.`
            );
        }
        return DEFAULT_REMINDER_JOB_INTERVAL_MINUTES;
    }
    return parsed;
};

/**
 * Keep in-app reminder entries synchronized with current log completeness and local-day rollover.
 */
const resolveInactiveInAppReminders = async (now: Date): Promise<void> => {
    const usersWithActiveInAppReminders = await prisma.user.findMany({
        where: {
            ...CURRENT_ACCOUNT_ACCESS_WHERE,
            in_app_notifications: {
                some: {
                    dismissed_at: null,
                    resolved_at: null
                }
            }
        },
        select: {
            id: true,
            timezone: true
        }
    });

    for (const user of usersWithActiveInAppReminders) {
        await resolveInactiveReminderNotificationsForUser({
            userId: user.id,
            timeZone: user.timezone,
            now
        });
    }
};

/** Keep due food and weight reminders in independent groups so their delivery/resolution identities remain separate. */
export const groupDueReminderTypes = ({
    dueWeight,
    dueFood
}: {
    dueWeight: boolean;
    dueFood: boolean;
}): InAppNotificationType[][] => {
    return [
        ...(dueWeight ? [[InAppNotificationType.LOG_WEIGHT_REMINDER]] : []),
        ...(dueFood ? [[InAppNotificationType.LOG_FOOD_REMINDER]] : [])
    ];
};

/**
 * Create scheduled in-app reminders and optionally fan out matching push notifications.
 */
export const createAndSendScheduledReminders = async (now: Date): Promise<void> => {
    const channels = [...DEFAULT_NOTIFICATION_DELIVERY_CHANNELS];

    const users = await prisma.user.findMany({
        where: {
            ...CURRENT_ACCOUNT_ACCESS_WHERE,
            OR: [{ reminder_log_weight_enabled: true }, { reminder_log_food_enabled: true }]
        },
        select: {
            id: true,
            timezone: true,
            reminder_log_weight_enabled: true,
            reminder_log_food_enabled: true,
            reminder_log_weight_minute: true,
            reminder_log_food_minute: true,
            reminder_quiet_hours_start_minute: true,
            reminder_quiet_hours_end_minute: true
        }
    });

    for (const user of users) {
        const timeZone = user.timezone || 'UTC';
        const { minuteOfDay } = getLocalWallClock(timeZone, now);
        if (isWithinQuietHours(
            minuteOfDay,
            user.reminder_quiet_hours_start_minute,
            user.reminder_quiet_hours_end_minute
        )) {
            continue;
        }

        const todayLocalDate = getSafeUtcTodayDateOnlyInTimeZone(timeZone, now);
        const { missingWeight, missingFood } = await getReminderMissingStatusForDate({
            userId: user.id,
            localDate: todayLocalDate,
            reminderLogWeightEnabled: user.reminder_log_weight_enabled,
            reminderLogFoodEnabled: user.reminder_log_food_enabled
        });

        const dueWeight = missingWeight && isReminderDue(minuteOfDay, user.reminder_log_weight_minute);
        const dueFood = missingFood && isReminderDue(minuteOfDay, user.reminder_log_food_minute);
        if (!dueWeight && !dueFood) {
            continue;
        }

        const reminderGroups = groupDueReminderTypes({
            dueWeight,
            dueFood
        });

        for (const reminderTypes of reminderGroups) {
            const includesWeight = reminderTypes.includes(InAppNotificationType.LOG_WEIGHT_REMINDER);
            const includesFood = reminderTypes.includes(InAppNotificationType.LOG_FOOD_REMINDER);
            const inAppNotifications: InAppNotificationDeliveryRequest[] = reminderTypes.map((type) => ({
                type,
                localDate: todayLocalDate,
                dedupeKey: buildReminderInAppDedupeKey(type, todayLocalDate)
            }));
            const result = await deliverUserNotification({
                userId: user.id,
                channels,
                inApp: inAppNotifications,
                push: {
                    payload: buildReminderPayload({
                        missingFood: includesFood,
                        missingWeight: includesWeight
                    }),
                    reminderTypes,
                    skipIfLastSentLocalDate: todayLocalDate,
                    markSentLocalDate: todayLocalDate
                }
            });

            if (result.push.failed > 0 && result.push.message) {
                console.warn(`Reminder push delivery had ${result.push.failed} failure(s); affected subscriptions remain eligible for retry.`);
            }
            if (result.push.skipped && result.push.message?.startsWith('Web push is disabled') && !hasLoggedMissingConfig) {
                console.warn(`${result.push.message} Native push delivery can still run when native tokens are registered.`);
                hasLoggedMissingConfig = true;
            }
        }
    }
};

const runReminderCheck = async (): Promise<void> => {
    const now = new Date();

    await materializeActiveFoodTrackingPauses(now);
    await resolveInactiveInAppReminders(now);
    await createAndSendScheduledReminders(now);
};

/**
 * Execute the reminder scan with overlap protection and crash-safe error handling.
 */
const runReminderCheckSafely = async (): Promise<void> => {
    if (isReminderCheckInProgress) {
        diagnosticsRegistry.recordJob('reminder_scheduler', 'skipped', 0);
        emitDiagnosticEvent(observabilityConfig, 'background_job.completed', {
            job: 'reminder_scheduler',
            outcome: 'skipped',
            duration_ms: 0
        });
        return;
    }

    isReminderCheckInProgress = true;
    const startedAt = process.hrtime.bigint();
    try {
        await runReminderCheck();
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        diagnosticsRegistry.recordJob('reminder_scheduler', 'success', durationMs);
        emitDiagnosticEvent(observabilityConfig, 'background_job.completed', {
            job: 'reminder_scheduler',
            outcome: 'success',
            duration_ms: Math.round(durationMs * 100) / 100
        });
    } catch (error) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        diagnosticsRegistry.recordJob('reminder_scheduler', 'failure', durationMs);
        emitDiagnosticEvent(observabilityConfig, 'background_job.completed', {
            job: 'reminder_scheduler',
            outcome: 'failure',
            duration_ms: Math.round(durationMs * 100) / 100,
            error_type: error instanceof Error ? error.name : 'UnknownError'
        });
        console.error('Reminder scheduler run failed; the next interval will retry (details omitted from logs).');
    } finally {
        isReminderCheckInProgress = false;
    }
};

/**
 * Start the reminder scheduler loop.
 */
export const startReminderScheduler = (): void => {
    const intervalMinutes = resolveJobIntervalMinutes();
    const intervalMs = intervalMinutes * MS_PER_MINUTE;

    emitDiagnosticEvent(observabilityConfig, 'background_job.scheduled', {
        job: 'reminder_scheduler',
        interval_minutes: intervalMinutes,
        schedule_source: 'account_local_wall_clock'
    });

    void runReminderCheckSafely();
    setInterval(() => {
        void runReminderCheckSafely();
    }, intervalMs);
};
