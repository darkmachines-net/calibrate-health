/** @file Allowlisted reminder notification copy, destinations, and provider-neutral push payloads. */

import { IN_APP_NOTIFICATION_ACTION_URLS, IN_APP_NOTIFICATION_TYPES } from '../../../shared/inAppNotifications';

export type PushNotificationAction = {
    action: string;
    title: string;
};

export type PushNotificationPayload = {
    title: string;
    body: string;
    url?: string;
    tag?: string;
    actions?: PushNotificationAction[];
    actionUrls?: Record<string, string>;
};

export const REMINDER_ACTION_IDS = {
    logWeight: 'log_weight',
    logFood: 'log_food'
} as const;

export const REMINDER_ACTIONS: PushNotificationAction[] = [
    { action: REMINDER_ACTION_IDS.logWeight, title: 'Log weight' },
    { action: REMINDER_ACTION_IDS.logFood, title: 'Log food' }
];

export const REMINDER_ACTION_URLS: Record<string, string> = {
    [REMINDER_ACTION_IDS.logWeight]:
        IN_APP_NOTIFICATION_ACTION_URLS[IN_APP_NOTIFICATION_TYPES.LOG_WEIGHT_REMINDER],
    [REMINDER_ACTION_IDS.logFood]:
        IN_APP_NOTIFICATION_ACTION_URLS[IN_APP_NOTIFICATION_TYPES.LOG_FOOD_REMINDER]
};

type ReminderPayloadOptions = {
    missingWeight: boolean;
    missingFood: boolean;
};

/**
 * Build a reminder payload tailored to today's missing logs.
 */
export const buildReminderPayload = (options: ReminderPayloadOptions): PushNotificationPayload => {
    const { missingWeight, missingFood } = options;
    const missingBoth = missingWeight && missingFood;

    let body = 'Log your progress for today.';
    let url = '/log';
    let tag = 'reminder';

    if (missingBoth) {
        body = 'Log your weight and food for today.';
        url = '/log';
        tag = 'reminder-both';
    } else if (missingWeight) {
        body = 'Log your weight for today.';
        url = REMINDER_ACTION_URLS[REMINDER_ACTION_IDS.logWeight];
        tag = 'reminder-weight';
    } else if (missingFood) {
        body = 'Log your food for today.';
        url = REMINDER_ACTION_URLS[REMINDER_ACTION_IDS.logFood];
        tag = 'reminder-food';
    }

    return {
        title: 'calibrate',
        body,
        url,
        tag,
        actions: REMINDER_ACTIONS,
        actionUrls: REMINDER_ACTION_URLS
    };
};
