/** @file Regression coverage for Guarded Tab Button: prevents default before asking and only replays an approved destination. */

import { fireEvent, render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { GuardedTabButton } from './GuardedTabButton';
import { registerNavigationGuard } from './guardedNavigation';

const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
    Link: require('react-native').Pressable,
    router: { navigate: (...args: unknown[]) => mockNavigate(...args) }
}));

describe.each(['web', 'android', 'ios'] as const)('GuardedTabButton on %s', (platform) => {
    let unregister: (() => void) | undefined;
    beforeEach(() => {
        jest.clearAllMocks();
        jest.replaceProperty(Platform, 'OS', platform);
    });
    afterEach(() => {
        unregister?.();
        unregister = undefined;
        jest.restoreAllMocks();
    });

    it('prevents default before asking and only replays an approved destination', () => {
        let resume: (() => void) | undefined;
        const guard = jest.fn(async (navigate: () => void) => { resume = navigate; });
        unregister = registerNavigationGuard(guard);
        const onPress = jest.fn();
        const event = { preventDefault: jest.fn() };
        const screen = render(<GuardedTabButton href="/today" testID="tab" onPress={onPress}>Today</GuardedTabButton>);
        fireEvent.press(screen.getByTestId('tab'), event);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(event.preventDefault.mock.invocationCallOrder[0]).toBeLessThan(guard.mock.invocationCallOrder[0]);
        expect(onPress).not.toHaveBeenCalled();
        expect(mockNavigate).not.toHaveBeenCalled();
        resume?.();
        expect(mockNavigate).toHaveBeenCalledWith('/today');
    });

    it('preserves the original tab handler when there is no focused guard', () => {
        const onPress = jest.fn();
        const event = { preventDefault: jest.fn() };
        const screen = render(<GuardedTabButton href="/progress" testID="tab" onPress={onPress}>Progress</GuardedTabButton>);
        fireEvent.press(screen.getByTestId('tab'), event);
        expect(onPress).toHaveBeenCalledWith(event);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(mockNavigate).not.toHaveBeenCalled();
    });

    if (platform === 'web') {
        it.each([
            { label: 'Ctrl', ctrlKey: true },
            { label: 'Meta', metaKey: true },
            { label: 'Shift', shiftKey: true },
            { label: 'Alt', altKey: true },
            { label: 'middle click', button: 1 },
            { label: 'new target', currentTarget: { target: '_blank' } },
            { label: 'already prevented', defaultPrevented: true },
        ])('does not intercept $label browser navigation', ({ label: _label, ...overrides }) => {
            const guard = jest.fn(async () => {});
            unregister = registerNavigationGuard(guard);
            const onPress = jest.fn();
            const event = { button: 0, currentTarget: { target: '' }, preventDefault: jest.fn(), ...overrides };
            const screen = render(<GuardedTabButton href="/today" testID="tab" onPress={onPress}>Today</GuardedTabButton>);
            fireEvent.press(screen.getByTestId('tab'), event);
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(guard).not.toHaveBeenCalled();
            expect(onPress).not.toHaveBeenCalled();
            expect(mockNavigate).not.toHaveBeenCalled();
        });
    }
});
