/** @file Regression coverage for native Platform: native platform mapping. */

import {
    getMobileDevicePlatform,
    getNativeDeviceName,
    getNativePlatformLabel,
    getNativePushPlatform,
    supportsAndroidIntegrations
} from './nativePlatform';

describe('native platform mapping', () => {
    it('maps Android and iOS to their API session and push identities', () => {
        expect(getMobileDevicePlatform('android')).toBe('android_phone');
        expect(getMobileDevicePlatform('ios')).toBe('ios');
        expect(getNativePushPlatform('android')).toBe('android');
        expect(getNativePushPlatform('ios')).toBe('ios');
    });

    it('uses device-appropriate labels for iPhone, iPad, and Android installs', () => {
        expect(getNativeDeviceName('ios', false)).toBe('iPhone');
        expect(getNativeDeviceName('ios', true)).toBe('iPad');
        expect(getNativeDeviceName('android', false)).toBe('Android device');
        expect(getNativePlatformLabel('ios')).toBe('iOS');
        expect(getNativePlatformLabel('android')).toBe('Android');
    });

    it('exposes Android-only integrations only on Android', () => {
        expect(supportsAndroidIntegrations('android')).toBe(true);
        expect(supportsAndroidIntegrations('ios')).toBe(false);
        expect(supportsAndroidIntegrations('web')).toBe(false);
    });
});
