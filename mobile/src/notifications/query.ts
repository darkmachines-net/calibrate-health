/** @file Notification cache identity and optimistic read/dismiss reconciliation with unread totals. */

import type { QueryClient } from '@tanstack/react-query';
import type { InAppNotification } from '@calibrate/api-client';

export const MOBILE_NOTIFICATION_QUERY_KEY = ['mobile-in-app-notifications'] as const;
export const ACTIVE_NOTIFICATION_LIMIT = 5;

export type NotificationListPage = {
    notifications: InAppNotification[];
    unread_count: number;
    next_cursor?: string | null;
};

export const activeNotificationQueryKey = [
    ...MOBILE_NOTIFICATION_QUERY_KEY,
    'active',
    ACTIVE_NOTIFICATION_LIMIT
] as const;

/** Removes a read notification from the active cache and reconciles its unread count. */
export function reconcileNotificationRead(
    queryClient: QueryClient,
    notificationId: number
): void {
    queryClient.setQueryData<NotificationListPage>(activeNotificationQueryKey, (current) => current ? ({
        ...current,
        notifications: current.notifications.filter(({ id }) => id !== notificationId),
        unread_count: Math.max(0, current.unread_count - (
            current.notifications.some(({ id }) => id === notificationId) ? 1 : 0
        ))
    }) : current);
}

/** Applies the same active-list reconciliation for a dismissed notification as for a read notification. */
export function reconcileNotificationDismissed(
    queryClient: QueryClient,
    notificationId: number
): void {
    reconcileNotificationRead(queryClient, notificationId);
}

/** Invalidates every notification query under the shared account cache root. */
export function invalidateNotificationQueries(queryClient: QueryClient): Promise<void> {
    return queryClient.invalidateQueries({ queryKey: [...MOBILE_NOTIFICATION_QUERY_KEY] });
}
