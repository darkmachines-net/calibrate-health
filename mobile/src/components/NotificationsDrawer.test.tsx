/** @file Regression coverage for Notifications Drawer: NotificationsDrawer. */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { InAppNotification } from '@calibrate/api-client';
import { IN_APP_NOTIFICATION_TYPES } from '@calibrate/shared/inAppNotifications';
import { ASYNC_RESOURCE_STATES } from '../asyncState/resolveAsyncState';
import { NotificationsDrawer, notificationDrawerWidth } from './NotificationsDrawer';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}));

const NOTIFICATION: InAppNotification = {
    id: 1,
    type: IN_APP_NOTIFICATION_TYPES.LOG_WEIGHT_REMINDER,
    local_date: '2026-07-20',
    title: 'Time to weigh in',
    body: 'Keep your trend current.',
    action_url: '/log?quickAdd=weight',
    read_at: null,
    dismissed_at: null,
    created_at: '2026-07-20T12:00:00.000Z'
};

async function renderDrawer(overrides: Partial<React.ComponentProps<typeof NotificationsDrawer>> = {}) {
    const props: React.ComponentProps<typeof NotificationsDrawer> = {
        visible: true,
        notifications: [NOTIFICATION],
        unreadCount: 1,
        state: { kind: ASYNC_RESOURCE_STATES.CONTENT, error: null },
        isBusy: false,
        onClose: jest.fn(),
        onOpenNotification: jest.fn(),
        onDismissNotification: jest.fn(),
        onRetry: jest.fn(),
        ...overrides
    };
    return { props, screen: await render(<NotificationsDrawer {...props} />) };
}

describe('NotificationsDrawer', () => {
    it('slides its panel independently instead of fading the entire modal', async () => {
        const { screen } = await renderDrawer();
        const modal = screen.container.queryAll((node) => node.type === 'Modal')[0];
        const panelStyle = StyleSheet.flatten(screen.getByTestId('notifications-drawer-panel').props.style);

        expect(modal.props.animationType).toBe('none');
        expect(modal.props.supportedOrientations).toEqual([
            'portrait',
            'portrait-upside-down',
            'landscape',
            'landscape-left',
            'landscape-right'
        ]);
        expect(panelStyle.transform).toHaveLength(1);
        expect(panelStyle.transform[0].translateX).toBeDefined();
    });

    it('uses the rendered panel width as its off-screen translation', () => {
        expect(notificationDrawerWidth(320)).toBe(288);
        expect(notificationDrawerWidth(390)).toBe(351);
        expect(notificationDrawerWidth(1_024)).toBe(440);
    });

    it('reviews and acts on notifications without requiring a notification-center route', async () => {
        const { props, screen } = await renderDrawer();

        expect(screen.getByText('1 unread')).toBeTruthy();
        expect(screen.getByText('Time to weigh in')).toBeTruthy();
        await fireEvent.press(screen.getByText('Log weight'));
        await fireEvent.press(screen.getByLabelText('Dismiss Time to weigh in'));

        expect(props.onOpenNotification).toHaveBeenCalledWith(NOTIFICATION);
        expect(props.onDismissNotification).toHaveBeenCalledWith(NOTIFICATION);
    });

    it('closes from the drawer header', async () => {
        const { props, screen } = await renderDrawer();

        await fireEvent.press(screen.getByLabelText('Close notifications'));

        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it.each([
        ASYNC_RESOURCE_STATES.CONTENT,
        ASYNC_RESOURCE_STATES.EMPTY,
        ASYNC_RESOURCE_STATES.LOADING,
        ASYNC_RESOURCE_STATES.ERROR,
        ASYNC_RESOURCE_STATES.STALE,
        ASYNC_RESOURCE_STATES.DEGRADED
    ])('has no archive entry point in the %s state', async (kind) => {
        const { screen } = await renderDrawer({ state: { kind, error: new Error('unavailable') } });
        expect(screen.queryByRole('button', { name: 'View all notifications' })).toBeNull();
        expect(screen.queryByTestId('view-all-notifications')).toBeNull();
    });

    it('exposes one modal dialog and keeps the decorative backdrop out of the accessibility tree', async () => {
        const { screen } = await renderDrawer();
        const modal = screen.container.queryAll((node) => node.type === 'Modal')[0];
        const panel = screen.getByTestId('notifications-drawer-panel');
        const backdrop = screen.getByTestId('notifications-drawer-backdrop', { includeHiddenElements: true });

        expect(modal.props.accessibilityLabel).toBeUndefined();
        expect(modal.props.accessibilityViewIsModal).toBeUndefined();
        expect(panel.props).toMatchObject({
            accessibilityLabel: 'Notifications',
            accessibilityViewIsModal: true,
            role: 'dialog'
        });
        expect(backdrop.props).toMatchObject({
            accessible: false,
            focusable: false,
            importantForAccessibility: 'no-hide-descendants',
            'aria-hidden': true
        });
    });

    it('does not render drawer content while closed', async () => {
        const { screen } = await renderDrawer({ visible: false });

        expect(screen.queryByText('Notifications')).toBeNull();
    });

    it('does not render empty reassurance when the notification request fails', async () => {
        const rawError = new Error('select * from private_notifications');
        const { props, screen } = await renderDrawer({
            notifications: [],
            unreadCount: null,
            state: { kind: ASYNC_RESOURCE_STATES.ERROR, error: rawError }
        });

        expect(screen.getByText("Can't load notifications")).toBeTruthy();
        expect(screen.getByText('Unread count unavailable')).toBeTruthy();
        expect(screen.queryByText('All caught up')).toBeNull();
        expect(screen.queryByText(rawError.message)).toBeNull();

        await act(async () => {
            await fireEvent.press(screen.getByText('Retry'));
        });
        expect(props.onRetry).toHaveBeenCalledTimes(1);
    });

    it('keeps cached notifications visible after a failed refresh', async () => {
        const { screen } = await renderDrawer({
            state: { kind: ASYNC_RESOURCE_STATES.DEGRADED, error: new Error('provider failed') }
        });

        expect(screen.getByText("Couldn't refresh notifications")).toBeTruthy();
        expect(screen.getByText('Time to weigh in')).toBeTruthy();
        expect(screen.queryByText('provider failed')).toBeNull();
    });

    it('does not relay notification action failures', async () => {
        const rawError = new Error('update notifications set read_at = now()');
        const { screen } = await renderDrawer({ actionError: rawError });

        expect(screen.getByText('Unable to update that notification. Try again.')).toBeTruthy();
        expect(screen.queryByText(rawError.message)).toBeNull();
        expect(screen.getByText('Time to weigh in')).toBeTruthy();
    });

    it('limits the quick drawer to five items while keeping the global unread count', async () => {
        const notifications = Array.from({ length: 7 }, (_, index) => ({
            ...NOTIFICATION,
            id: index + 1,
            title: `Reminder ${index + 1}`
        }));
        const { screen } = await renderDrawer({ notifications, unreadCount: 7 });

        expect(screen.getByTestId('notifications-drawer-list')).toBeTruthy();
        expect(screen.getByText('Reminder 1')).toBeTruthy();
        expect(screen.getByText('Reminder 5')).toBeTruthy();
        expect(screen.queryByText('Reminder 6')).toBeNull();
        expect(screen.getByText('7 unread')).toBeTruthy();
        expect(screen.queryByTestId('view-all-notifications')).toBeNull();
    });

    it('keeps the editor behind the modal while opening and restores dismissal after failure', async () => {
        const { props, screen } = await renderDrawer({ isOpening: true, isBusy: true });
        expect(screen.getByText('Opening reminder...')).toBeTruthy();
        expect(screen.getByLabelText('Close notifications').props.accessibilityState.disabled).toBe(true);
        await fireEvent.press(screen.getByLabelText('Close notifications'));
        await act(() => screen.container.queryAll((node) => node.type === 'Modal')[0].props.onRequestClose());
        await fireEvent.press(screen.getByTestId('notifications-drawer-backdrop', { includeHiddenElements: true }));
        expect(props.onClose).not.toHaveBeenCalled();
        await screen.rerender(<NotificationsDrawer {...props} isOpening={false} isBusy={false} actionError={new Error('failed')} />);
        expect(screen.queryByText('Opening reminder...')).toBeNull();
        await fireEvent.press(screen.getByLabelText('Close notifications'));
        await act(() => screen.container.queryAll((node) => node.type === 'Modal')[0].props.onRequestClose());
        await fireEvent.press(screen.getByTestId('notifications-drawer-backdrop', { includeHiddenElements: true }));
        expect(props.onClose).toHaveBeenCalledTimes(3);
    });

    it('closes through native Back and backdrop without opening another route', async () => {
        const { props, screen } = await renderDrawer();
        await act(() => screen.container.queryAll((node) => node.type === 'Modal')[0].props.onRequestClose());
        await fireEvent.press(screen.getByTestId('notifications-drawer-backdrop', { includeHiddenElements: true }));
        expect(props.onClose).toHaveBeenCalledTimes(2);
    });
});
