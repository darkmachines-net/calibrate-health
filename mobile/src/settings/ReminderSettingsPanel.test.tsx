/** @file Regression coverage for Reminder Settings Panel: ReminderSettingsPanel. */

import { fireEvent, render } from '@testing-library/react-native';
import { ReminderSettingsPanel } from './ReminderSettingsPanel';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

async function renderPanel() {
    const callbacks = {
        onLogFoodEnabledChange: jest.fn(),
        onLogWeightEnabledChange: jest.fn(),
        onFoodTimeChange: jest.fn(),
        onWeightTimeChange: jest.fn(),
        onQuietStartChange: jest.fn(),
        onQuietEndChange: jest.fn(),
        onRequestPermission: jest.fn(),
        onOpenPermissionSettings: jest.fn(),
        onRefreshPermission: jest.fn(),
        onRetryRegistration: jest.fn(),
        onDisableRegistration: jest.fn()
    };
    const screen = await render(
        <ReminderSettingsPanel
            timezone="America/Los_Angeles"
            logFoodEnabled
            logWeightEnabled={false}
            foodTime="09:00"
            weightTime="18:30"
            quietStart="22:00"
            quietEnd="07:00"
            errors={{}}
            deliveryStatus={{
                message: 'Allow notifications to receive reminders.',
                action: 'request',
                isError: false
            }}
            isWeb
            {...callbacks}
        />
    );
    return { screen, callbacks };
}

describe('ReminderSettingsPanel', () => {
    it('separates account reminder intent from runtime delivery permission', async () => {
        const { screen, callbacks } = await renderPanel();

        expect(screen.getByTestId('settings-reminder-intent')).toBeTruthy();
        expect(screen.getByTestId('settings-delivery-permission')).toBeTruthy();
        expect(screen.getByText(/same local wall-clock time in America\/Los_Angeles/)).toBeTruthy();
        expect(screen.getByTestId('settings-food-reminder-time').props.editable).toBe(true);
        expect(screen.getByTestId('settings-weight-reminder-time').props.editable).toBe(false);

        expect(screen.getAllByRole('switch')).toHaveLength(2);
        const foodReminderSwitch = screen.getByRole('switch', { name: 'Food reminders' });
        expect(foodReminderSwitch.props.accessibilityState).toEqual(expect.objectContaining({ checked: true }));
        await fireEvent.press(foodReminderSwitch);
        await fireEvent.press(screen.getByRole('button', { name: 'Enable push notifications' }));

        expect(callbacks.onLogFoodEnabledChange).toHaveBeenCalledWith(false);
        expect(callbacks.onRequestPermission).toHaveBeenCalledTimes(1);
    });
});
