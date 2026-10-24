/** @file Regression coverage for Connected Apps Panel: ConnectedAppsPanel. */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { ConnectedAppSummary } from '@calibrate/api-client';
import { ConnectedAppsPanel } from './ConnectedAppsPanel';

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

const connection: ConnectedAppSummary = {
    id: 'c13e23d9-b130-42bd-bb70-901fd65fbfe9',
    client_id: 'codex-client',
    client_name: 'Codex',
    scopes: ['calibrate:food:read', 'calibrate:weight:read'],
    resource: 'https://calibratehealth.app/mcp',
    created_at: '2026-08-19T12:00:00.000Z',
    last_used_at: null,
    expires_at: '2026-09-18T12:00:00.000Z'
};

describe('ConnectedAppsPanel', () => {
    it('discloses plan context and keeps confirmation open when revocation fails', async () => {
        const onRevoke = jest.fn().mockRejectedValue(new Error('offline'));
        const screen = render(
            <ConnectedAppsPanel connections={[connection]} onRevoke={onRevoke} />
        );

        expect(screen.getByText(
            'Food logs + calorie plan context | Weight progress + calorie plan context'
        )).toBeTruthy();
        fireEvent.press(screen.getByTestId(`settings-connected-app-revoke-${connection.id}`));
        await act(async () => {
            fireEvent.press(screen.getByTestId('settings-connected-app-confirm-revoke'));
        });

        expect(onRevoke).toHaveBeenCalledWith(connection.id);
        expect(screen.getByText('Revoke connected assistant?')).toBeTruthy();
        screen.rerender(
            <ConnectedAppsPanel
                connections={[connection]}
                errorMessage="Unable to revoke that connected assistant."
                onRevoke={onRevoke}
            />
        );
        expect(screen.getByText('Unable to revoke that connected assistant.').props.accessibilityRole)
            .toBe('alert');
    });
});
