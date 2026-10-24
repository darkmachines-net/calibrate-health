/** @file camera Runtime: Allows native camera mounting so CameraView can report real initialization failures after permission. */

import { Linking } from 'react-native';

export const cameraPermissionCopy = {
    blockedDescription: 'Camera access is blocked for Calibrate. Enable it from the app permissions screen.',
    blockedMessage: 'Camera access is blocked. Open device settings to enable it.',
    stillBlockedMessage: 'Camera access is still disabled in device settings.',
    settingsActionTitle: 'Open device settings',
    settingsActionHint: 'Opens the Calibrate app permissions in device settings.',
    openedSettingsMessage: 'After enabling Camera in device settings, return here and check access again.',
    openSettingsError: 'Unable to open device settings. Open the Calibrate app permissions manually.'
} as const;

/** Allows native camera mounting so CameraView can report real initialization failures after permission. */
export async function isBarcodeCameraAvailable(): Promise<boolean> {
    // Expo's availability preflight is web-only. Native startup failures are reported by
    // CameraView.onMountError after permission is granted, so allow the real camera to mount.
    return true;
}

/** Opens native app settings for camera permission recovery, returning false when navigation fails. */
export async function openBarcodeCameraSettings(): Promise<boolean> {
    try {
        await Linking.openSettings();
        return true;
    } catch {
        return false;
    }
}
