/** @file Native platform and build-environment identification used at client capability boundaries. */

import { MOBILE_DEVICE_PLATFORMS, NATIVE_PUSH_PLATFORMS } from '@calibrate/shared';
import { Platform } from 'react-native';

/** Map the React Native runtime to the server's phone/tablet session identity. */
export function getMobileDevicePlatform(platform: string = Platform.OS) {
    return platform === 'ios'
        ? MOBILE_DEVICE_PLATFORMS.IOS
        : MOBILE_DEVICE_PLATFORMS.ANDROID_PHONE;
}

/** Expo push tokens are delivered through FCM on Android and APNs on iOS. */
export function getNativePushPlatform(platform: string = Platform.OS) {
    return platform === 'ios'
        ? NATIVE_PUSH_PLATFORMS.IOS
        : NATIVE_PUSH_PLATFORMS.ANDROID;
}

/** Returns the native platform name used in user-facing setup instructions. */
export function getNativePlatformLabel(platform: string = Platform.OS): 'Android' | 'iOS' {
    return platform === 'ios' ? 'iOS' : 'Android';
}

/** Returns a platform-appropriate device label, distinguishing iPad from iPhone. */
export function getNativeDeviceName(
    platform: string = Platform.OS,
    isPad = platform === 'ios' && Boolean((Platform as typeof Platform & { isPad?: boolean }).isPad)
): string {
    if (platform !== 'ios') return 'Android device';
    return isPad ? 'iPad' : 'iPhone';
}

/** Restricts Android-only integration entry points to the Android runtime. */
export function supportsAndroidIntegrations(platform: string = Platform.OS): boolean {
    return platform === 'android';
}
