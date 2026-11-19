/** @file Shared account notification SSE event names, reasons, and payload helpers. */

export const NOTIFICATION_REALTIME_EVENT_NAME = 'notification-update';

export const NOTIFICATION_REALTIME_REASONS = {
    CREATED: 'created',
    READ: 'read',
    DISMISSED: 'dismissed',
    RESOLVED: 'resolved',
    CLEARED: 'cleared'
} as const;

export type NotificationRealtimeReason =
    (typeof NOTIFICATION_REALTIME_REASONS)[keyof typeof NOTIFICATION_REALTIME_REASONS];

export type NotificationRealtimePayload = {
    reason: NotificationRealtimeReason;
    updated_at: string;
};

const NOTIFICATION_REALTIME_REASON_VALUES = new Set<string>(Object.values(NOTIFICATION_REALTIME_REASONS));

/**
 * Build an SSE notification payload with the supplied reason and an ISO timestamp.
 */
export const buildNotificationRealtimePayload = (
    reason: NotificationRealtimeReason,
    now = new Date()
): NotificationRealtimePayload => ({
    reason,
    updated_at: now.toISOString()
});

/** Accept recognized notification reasons paired with a nonempty timestamp string. */
export const isNotificationRealtimePayload = (value: unknown): value is NotificationRealtimePayload => {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as { reason?: unknown; updated_at?: unknown };
    return (
        typeof candidate.reason === 'string' &&
        NOTIFICATION_REALTIME_REASON_VALUES.has(candidate.reason) &&
        typeof candidate.updated_at === 'string' &&
        candidate.updated_at.trim().length > 0
    );
};
