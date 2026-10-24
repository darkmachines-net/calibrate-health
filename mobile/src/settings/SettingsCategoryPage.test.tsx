/** @file Covers settings category navigation, offline summaries, and software-license access. */

import { fireEvent, render } from '@testing-library/react-native';
import { SettingsCategoryPage } from './SettingsCategoryPage';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

jest.mock('../config/nativeClient', () => ({
    MOBILE_CLIENT_IDENTITY: { version: '0.0.0-test' }
}));

function createCallbacks() {
    return {
        onOpenPage: jest.fn(),
        onOpenSheet: jest.fn(),
        onOpenProductLink: jest.fn(),
        onDeleteAccount: jest.fn(),
        onLogout: jest.fn()
    };
}

const resourceProps = {
    showAndroidIntegrations: false,
    sessionCount: 3,
    connectedAppCount: 2,
    isOutboxReady: true,
    failedMutationCount: 1,
    pendingMutationCount: 4
};

describe('SettingsCategoryPage', () => {
    it('keeps profile and preference destinations in Profile & preferences', () => {
        const callbacks = createCallbacks();
        const screen = render(
            <SettingsCategoryPage
                category="profile"
                isWeb
                {...resourceProps}
                {...callbacks}
            />
        );

        expect(screen.getByTestId('settings-category-profile')).toBeTruthy();
        expect(screen.getByTestId('settings-section-profile')).toBeTruthy();
        expect(screen.getAllByRole('button').map((button) => button.props.accessibilityLabel)).toEqual([
            'Profile photo',
            'Profile details',
            'Preferences'
        ]);

        fireEvent.press(screen.getByRole('button', { name: 'Profile photo' }));
        fireEvent.press(screen.getByRole('button', { name: 'Profile details' }));
        fireEvent.press(screen.getByRole('button', { name: 'Preferences' }));

        expect(callbacks.onOpenSheet.mock.calls).toEqual([
            ['profile-photo']
        ]);
        expect(callbacks.onOpenPage.mock.calls).toEqual([['profile-details'], ['preferences']]);
    });

    it('keeps password, session, and logout destinations in Security & access', () => {
        const callbacks = createCallbacks();
        const screen = render(
            <SettingsCategoryPage
                category="security"
                isWeb
                {...resourceProps}
                {...callbacks}
            />
        );

        expect(screen.getByTestId('settings-category-security')).toBeTruthy();
        expect(screen.getAllByRole('button').map((button) => button.props.accessibilityLabel)).toEqual([
            'Password',
            'Signed-in devices, 3',
            'Log out'
        ]);

        fireEvent.press(screen.getByRole('button', { name: 'Password' }));
        fireEvent.press(screen.getByRole('button', { name: 'Signed-in devices, 3' }));
        fireEvent.press(screen.getByRole('button', { name: 'Log out' }));

        expect(callbacks.onOpenSheet.mock.calls).toEqual([
            ['password']
        ]);
        expect(callbacks.onOpenPage).toHaveBeenCalledWith('devices');
        expect(callbacks.onLogout).toHaveBeenCalledTimes(1);
    });

    it.each([true, false])('hides Android connections on web/iOS (isWeb=%s)', (isWeb) => {
        const callbacks = createCallbacks();
        const screen = render(
            <SettingsCategoryPage
                category="connections"
                isWeb={isWeb}
                {...resourceProps}
                {...callbacks}
            />
        );

        expect(screen.getByTestId('settings-category-connections')).toBeTruthy();
        expect(screen.getAllByRole('button').map((button) => button.props.accessibilityLabel)).toEqual([
            'Activity',
            'Connected assistants, 2'
        ]);
        expect(screen.queryByRole('button', { name: 'Health Connect' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Galaxy Watch' })).toBeNull();

        fireEvent.press(screen.getByRole('button', { name: 'Activity' }));
        fireEvent.press(screen.getByRole('button', { name: 'Connected assistants, 2' }));

        expect(callbacks.onOpenSheet).not.toHaveBeenCalled();
        expect(callbacks.onOpenPage.mock.calls).toEqual([
            ['activity'],
            ['connected-apps']
        ]);
    });

    it('shows Android connection destinations and opens their pages', () => {
        const callbacks = createCallbacks();
        const screen = render(
            <SettingsCategoryPage
                category="connections"
                isWeb={false}
                {...resourceProps}
                showAndroidIntegrations
                {...callbacks}
            />
        );

        expect(screen.getAllByRole('button').map((button) => button.props.accessibilityLabel)).toEqual([
            'Activity',
            'Health Connect',
            'Galaxy Watch',
            'Connected assistants, 2'
        ]);
        fireEvent.press(screen.getByRole('button', { name: 'Health Connect' }));
        expect(callbacks.onOpenPage).toHaveBeenCalledWith('health-connect');
        fireEvent.press(screen.getByRole('button', { name: 'Galaxy Watch' }));
        expect(callbacks.onOpenPage).toHaveBeenCalledWith('watch');
        expect(callbacks.onOpenSheet).not.toHaveBeenCalled();
    });

    it('keeps saved content, import, sync, export, and deletion in Data & privacy', () => {
        const callbacks = createCallbacks();
        const screen = render(
            <SettingsCategoryPage
                category="data"
                isWeb
                {...resourceProps}
                {...callbacks}
            />
        );

        expect(screen.getByTestId('settings-category-data')).toBeTruthy();
        expect(screen.getAllByRole('button').map((button) => button.props.accessibilityLabel)).toEqual([
            'Saved foods',
            'Import from Lose It',
            'Offline changes, 1 failed',
            'Export account data',
            'Delete account'
        ]);

        fireEvent.press(screen.getByRole('button', { name: 'Saved foods' }));
        fireEvent.press(screen.getByRole('button', { name: 'Import from Lose It' }));
        fireEvent.press(screen.getByRole('button', { name: 'Offline changes, 1 failed' }));
        fireEvent.press(screen.getByRole('button', { name: 'Export account data' }));
        fireEvent.press(screen.getByRole('button', { name: 'Delete account' }));

        expect(callbacks.onOpenPage).toHaveBeenCalledWith('my-foods');
        expect(callbacks.onOpenSheet.mock.calls).toEqual([
            ['import'],
            ['offline'],
            ['export']
        ]);
        expect(callbacks.onDeleteAccount).toHaveBeenCalledTimes(1);
    });

    it('keeps every product link and app destination in Help & app', () => {
        const callbacks = createCallbacks();
        const screen = render(
            <SettingsCategoryPage
                category="help"
                isWeb
                {...resourceProps}
                {...callbacks}
            />
        );

        expect(screen.getByTestId('settings-category-help')).toBeTruthy();
        expect(screen.getAllByTestId(/^settings-section-/).map((section) => section.props.testID)).toEqual([
            'settings-section-help',
            'settings-section-app'
        ]);

        fireEvent.press(screen.getByRole('button', { name: 'Support and feedback' }));
        fireEvent.press(screen.getByRole('button', { name: 'Privacy policy' }));
        fireEvent.press(screen.getByRole('button', { name: 'Terms of service' }));
        fireEvent.press(screen.getByRole('button', { name: 'Software license' }));
        fireEvent.press(screen.getByRole('button', { name: 'About Calibrate' }));
        fireEvent.press(screen.getByRole('button', { name: 'Advanced settings' }));

        expect(callbacks.onOpenProductLink.mock.calls).toEqual([
            ['support'],
            ['privacy'],
            ['terms'],
            ['licenses']
        ]);
        expect(callbacks.onOpenPage.mock.calls).toEqual([['about'], ['advanced']]);
    });
});
