/** @file Regression coverage for query: active notification query reconciliation. */

import { QueryClient } from '@tanstack/react-query';
import type { InAppNotification } from '@calibrate/api-client';
import { IN_APP_NOTIFICATION_TYPES } from '@calibrate/shared/inAppNotifications';
import {
    activeNotificationQueryKey,
    invalidateNotificationQueries,
    reconcileNotificationDismissed,
    reconcileNotificationRead,
    type NotificationListPage
} from './query';

function notification(id: number): InAppNotification {
    return {
        id,
        type: IN_APP_NOTIFICATION_TYPES.GENERIC,
        local_date: '2026-08-09',
        title: `Notification ${id}`,
        body: 'Body',
        action_url: '/today',
        read_at: null,
        dismissed_at: null,
        created_at: '2026-08-09T12:00:00.000Z'
    };
}

describe('active notification query reconciliation', () => {
    it.each([reconcileNotificationRead, reconcileNotificationDismissed])(
        'removes one reminder and decrements the global unread count only once',
        (reconcile) => {
            const client = new QueryClient();
            client.setQueryData(activeNotificationQueryKey, {
                notifications: [notification(2), notification(1)],
                unread_count: 7,
                next_cursor: 'more-active'
            });
            reconcile(client, 2);
            reconcile(client, 2);
            expect(client.getQueryData<NotificationListPage>(activeNotificationQueryKey)).toMatchObject({
                unread_count: 6,
                notifications: [{ id: 1 }],
                next_cursor: 'more-active'
            });
            expect(client.getQueryCache().getAll()).toHaveLength(1);
            client.clear();
        }
    );

    it('does not invent cached data or decrement for a reminder outside the quick list', () => {
        const client = new QueryClient();
        reconcileNotificationRead(client, 99);
        expect(client.getQueryData(activeNotificationQueryKey)).toBeUndefined();
        client.setQueryData(activeNotificationQueryKey, { notifications: [notification(1)], unread_count: 7 });
        reconcileNotificationDismissed(client, 99);
        expect(client.getQueryData<NotificationListPage>(activeNotificationQueryKey)?.unread_count).toBe(7);
        client.clear();
    });

    it('invalidates the active query for new arrivals and authoritative refetch after mutations', async () => {
        const client = new QueryClient();
        client.setQueryData(activeNotificationQueryKey, { notifications: [notification(1)], unread_count: 1 });
        await invalidateNotificationQueries(client);
        expect(client.getQueryState(activeNotificationQueryKey)?.isInvalidated).toBe(true);
        client.clear();
    });
});
