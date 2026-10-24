/** @file Regression coverage for workflow: native notification workflow. */

import {
    getNotificationAction,
    getNotificationPermissionState,
    getNotificationResponseActionUrl,
    getPushStatusPresentation,
    getPushStatusTarget,
    isNativePushEnvironmentSupported,
    NATIVE_PUSH_STATES
} from './workflow';

describe('native notification workflow', () => {
    it('distinguishes permission retry from blocked settings recovery', () => {
        expect(getNotificationPermissionState({ granted: true, canAskAgain: true })).toBe(NATIVE_PUSH_STATES.REGISTERING);
        expect(getNotificationPermissionState({ granted: false, canAskAgain: true })).toBe(NATIVE_PUSH_STATES.PERMISSION_REQUIRED);
        expect(getNotificationPermissionState({ granted: false, canAskAgain: false })).toBe(NATIVE_PUSH_STATES.BLOCKED);
        expect(getPushStatusPresentation(NATIVE_PUSH_STATES.PERMISSION_REQUIRED).action).toBe('request');
        expect(getPushStatusPresentation(NATIVE_PUSH_STATES.BLOCKED).action).toBe('settings');
    });

    it('supports Android and iOS native builds but not Expo Go or web', () => {
        expect(isNativePushEnvironmentSupported('expo', 'android')).toBe(false);
        expect(isNativePushEnvironmentSupported('expo', 'ios')).toBe(false);
        expect(isNativePushEnvironmentSupported('standalone', 'android')).toBe(true);
        expect(isNativePushEnvironmentSupported('standalone', 'ios')).toBe(true);
        expect(isNativePushEnvironmentSupported('standalone', 'web')).toBe(false);
        expect(getPushStatusTarget('android')).toBe('android');
        expect(getPushStatusTarget('ios')).toBe('ios');
        expect(getPushStatusTarget('web')).toBe('web');
    });

    it('uses iOS-specific native push recovery copy', () => {
        expect(getPushStatusPresentation(NATIVE_PUSH_STATES.BLOCKED, 'ios').message).toContain('iOS settings');
        expect(getPushStatusPresentation(NATIVE_PUSH_STATES.UNSUPPORTED, 'ios').message).toContain('native iOS');
    });

    it('explains when the selected self-host disables third-party native push', () => {
        expect(getPushStatusPresentation(NATIVE_PUSH_STATES.DISABLED)).toEqual({
            message: 'Native push is disabled by this Calibrate server.',
            action: null,
            isError: false
        });
    });

    it('uses browser-specific push status copy and recovery actions on web', () => {
        expect(getPushStatusPresentation(NATIVE_PUSH_STATES.BLOCKED, 'web')).toEqual({
            message: 'Notifications are blocked for this site. Allow them in browser site settings, then check again.',
            action: 'settings',
            isError: true
        });
        expect(getPushStatusPresentation(NATIVE_PUSH_STATES.DISABLED, 'web').message).toBe(
            'Browser push is disabled by this Calibrate server.'
        );
        expect(getPushStatusPresentation(NATIVE_PUSH_STATES.UNSUPPORTED, 'web').message).toMatch(/browser/i);
        expect(getPushStatusPresentation(NATIVE_PUSH_STATES.ERROR, 'web').action).toBe('retry');
        expect(getPushStatusPresentation(NATIVE_PUSH_STATES.REGISTERED, 'web').action).toBe('disable');
    });

    it('maps food, weight, and goal actions to allowlisted native routes', () => {
        expect(getNotificationAction('/log?quickAdd=food', '2026-07-12')).toEqual({
            label: 'Log food',
            href: { pathname: '/log', params: { date: '2026-07-12' } }
        });
        expect(getNotificationAction('/log?quickAdd=weight', '2026-07-12')).toEqual({
            label: 'Log weight',
            href: { pathname: '/weight', params: { date: '2026-07-12' } }
        });
        expect(getNotificationAction('/goals')).toEqual({ label: 'Open goals', href: '/progress' });
    });

    it.each([
        'https://evil.example/log?quickAdd=weight',
        '//evil.example/log',
        'javascript:alert(1)',
        '/unknown/path',
        '/log\\..\\settings',
        undefined
    ])('falls back safely for invalid or external action URL %p', (actionUrl) => {
        expect(getNotificationAction(actionUrl)).toEqual({
            label: 'Open Calibrate',
            href: '/today'
        });
    });

    it('uses a tapped action URL before the notification default', () => {
        const data = {
            url: '/log',
            actionUrls: {
                log_weight: '/log?quickAdd=weight',
                external: 'https://evil.example'
            }
        };

        expect(getNotificationResponseActionUrl(data, 'log_weight')).toBe('/log?quickAdd=weight');
        expect(getNotificationResponseActionUrl(data, 'unknown')).toBe('/log');
        expect(getNotificationAction(getNotificationResponseActionUrl(data, 'external')).href).toBe('/today');
    });
});
