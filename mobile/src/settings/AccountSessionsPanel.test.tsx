/** @file Regression coverage for Account Sessions Panel: AccountSessionsPanel. */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { AccountSessionSummary } from '@calibrate/api-client';
import { AccountSessionsPanel } from './AccountSessionsPanel';

jest.mock('../components/BottomSheetModal', () => {
    const ReactModule = require('react') as typeof React;
    const { Text, View } = require('react-native') as typeof import('react-native');
    return {
        BottomSheetModal: ({ visible, title, description, children }: {
            visible: boolean;
            title?: string;
            description?: string;
            children: React.ReactNode;
        }) => visible ? ReactModule.createElement(
            View,
            { role: 'dialog', accessibilityLabel: title },
            ReactModule.createElement(Text, null, title),
            ReactModule.createElement(Text, null, description),
            children
        ) : null
    };
});

const sessions: AccountSessionSummary[] = [
    {
        id: 'browser_current',
        kind: 'browser',
        device_label: 'Chrome on Windows',
        created_at: '2026-08-01T12:00:00.000Z',
        last_activity_at: '2026-08-09T12:00:00.000Z',
        current: true
    },
    {
        id: 'mobile_remote',
        kind: 'android_phone',
        device_label: 'Pixel 9',
        created_at: '2026-07-01T12:00:00.000Z',
        last_activity_at: null,
        current: false
    },
    {
        id: 'ios_remote',
        kind: 'ios',
        device_label: null,
        created_at: '2026-07-02T12:00:00.000Z',
        last_activity_at: '2026-08-08T12:00:00.000Z',
        current: false
    }
];

describe('AccountSessionsPanel', () => {
    it('protects the current session and confirms remote and bulk revocation in adaptive dialogs', async () => {
        const onRevoke = jest.fn().mockResolvedValue(undefined);
        const onRevokeOthers = jest.fn().mockResolvedValue(undefined);
        const screen = await render(
            <AccountSessionsPanel
                sessions={sessions}
                revokingOthers={false}
                onRevoke={onRevoke}
                onRevokeOthers={onRevokeOthers}
            />
        );

        expect(screen.getByTestId('settings-session-browser_current')).toBeTruthy();
        expect(screen.getByText('This session')).toBeTruthy();
        expect(screen.queryByTestId('settings-session-revoke-browser_current')).toBeNull();
        expect(screen.getAllByText('iPhone or iPad')).toHaveLength(2);
        expect(screen.getByText('Last activity: Not recorded')).toBeTruthy();

        await fireEvent.press(screen.getByTestId('settings-session-revoke-mobile_remote'));
        expect(screen.getByTestId('settings-session-confirmation')).toBeTruthy();
        expect(screen.getByText('Revoke signed-in session?')).toBeTruthy();
        expect(screen.getByText('This signs Pixel 9 out remotely.')).toBeTruthy();
        await act(async () => {
            await fireEvent.press(screen.getByTestId('settings-session-confirm'));
        });
        expect(onRevoke).toHaveBeenCalledWith('mobile_remote');

        await fireEvent.press(screen.getByTestId('settings-session-revoke-others'));
        expect(screen.getByText('Revoke all other sessions?')).toBeTruthy();
        await act(async () => {
            await fireEvent.press(screen.getByTestId('settings-session-confirm'));
        });
        expect(onRevokeOthers).toHaveBeenCalledTimes(1);
    });

    it('keeps a revoke failure reachable inside the open confirmation', async () => {
        const onRevoke = jest.fn().mockRejectedValue(new Error('offline'));
        const onRevokeOthers = jest.fn().mockResolvedValue(undefined);
        const screen = await render(
            <AccountSessionsPanel
                sessions={sessions}
                revokingOthers={false}
                onRevoke={onRevoke}
                onRevokeOthers={onRevokeOthers}
            />
        );

        await fireEvent.press(screen.getByTestId('settings-session-revoke-mobile_remote'));
        await act(async () => {
            await fireEvent.press(screen.getByTestId('settings-session-confirm'));
        });
        await screen.rerender(
            <AccountSessionsPanel
                sessions={sessions}
                revokingOthers={false}
                errorMessage="Unable to revoke that signed-in session."
                onRevoke={onRevoke}
                onRevokeOthers={onRevokeOthers}
            />
        );

        expect(screen.getByText('Unable to revoke that signed-in session.').props.accessibilityRole)
            .toBe('alert');
        expect(screen.getByTestId('settings-session-confirmation')).toBeTruthy();
    });
});
