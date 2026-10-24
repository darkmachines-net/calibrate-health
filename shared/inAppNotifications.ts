/** @file Notification kinds, stable destinations, and public reminder wire contracts. */

export const IN_APP_NOTIFICATION_TYPES = {
    LOG_WEIGHT_REMINDER: 'LOG_WEIGHT_REMINDER',
    LOG_FOOD_REMINDER: 'LOG_FOOD_REMINDER',
    GENERIC: 'GENERIC'
} as const;

export type InAppNotificationType =
    (typeof IN_APP_NOTIFICATION_TYPES)[keyof typeof IN_APP_NOTIFICATION_TYPES];

/**
 * Query param and action values used for quick-add deep links from reminder notifications.
 */
const QUICK_ADD_QUERY_PARAM = 'quickAdd' as const;
const QUICK_ADD_ACTIONS = {
    food: 'food',
    weight: 'weight'
} as const;

const buildQuickAddUrl = (
    action: (typeof QUICK_ADD_ACTIONS)[keyof typeof QUICK_ADD_ACTIONS]
): string => `/log?${QUICK_ADD_QUERY_PARAM}=${action}`;

/**
 * Stable in-app reminder destinations for each notification type.
 */
export const IN_APP_NOTIFICATION_ACTION_URLS: Record<InAppNotificationType, string> = {
    [IN_APP_NOTIFICATION_TYPES.LOG_WEIGHT_REMINDER]: buildQuickAddUrl(QUICK_ADD_ACTIONS.weight),
    [IN_APP_NOTIFICATION_TYPES.LOG_FOOD_REMINDER]: buildQuickAddUrl(QUICK_ADD_ACTIONS.food),
    [IN_APP_NOTIFICATION_TYPES.GENERIC]: '/log'
};
