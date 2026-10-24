/** @file notification Realtime: Owns in-process notification fanout for connected SSE clients. */

import {
    NOTIFICATION_REALTIME_EVENT_NAME,
    buildNotificationRealtimePayload,
    type NotificationRealtimePayload,
    type NotificationRealtimeReason
} from '../../../shared/notificationRealtime';

type NotificationRealtimeSubscriber = (payload: NotificationRealtimePayload) => void;

const subscribersByUserId = new Map<number, Set<NotificationRealtimeSubscriber>>();

/**
 * Owns in-process notification fanout for connected SSE clients.
 *
 * This deliberately does not know about Express responses, so notification domain code can publish state changes
 * without depending on a transport implementation.
 */
export const subscribeToNotificationRealtimeUpdates = ({
    userId,
    onUpdate
}: {
    userId: number;
    onUpdate: NotificationRealtimeSubscriber;
}): (() => void) => {
    const existingSubscribers = subscribersByUserId.get(userId);
    const subscribers = existingSubscribers ?? new Set<NotificationRealtimeSubscriber>();
    subscribers.add(onUpdate);

    if (!existingSubscribers) {
        subscribersByUserId.set(userId, subscribers);
    }

    return () => {
        subscribers.delete(onUpdate);
        if (subscribers.size === 0) {
            subscribersByUserId.delete(userId);
        }
    };
};

/**
 * Publish a notification state change to the authenticated user's active SSE connections.
 */
export const publishNotificationRealtimeUpdate = ({
    userId,
    reason,
    now = new Date()
}: {
    userId: number;
    reason: NotificationRealtimeReason;
    now?: Date;
}): NotificationRealtimePayload => {
    const payload = buildNotificationRealtimePayload(reason, now);
    const subscribers = subscribersByUserId.get(userId);

    if (subscribers) {
        for (const subscriber of subscribers) {
            subscriber(payload);
        }
    }

    return payload;
};

/**
 * Expose subscriber counts for tests and lightweight operational assertions.
 */
export const getNotificationRealtimeSubscriberCount = (userId: number): number => {
    return subscribersByUserId.get(userId)?.size ?? 0;
};

export { NOTIFICATION_REALTIME_EVENT_NAME };
