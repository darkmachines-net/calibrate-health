/** @file camera Runtime: Checks browser camera availability and treats unsupported or failed preflight checks as unavailable. */

import { CameraView } from 'expo-camera';

export const cameraPermissionCopy = {
    blockedDescription: 'Camera access is blocked for this site. Enable it from your browser site settings.',
    blockedMessage: 'Camera access is blocked. Enable it in your browser site settings.',
    stillBlockedMessage: 'Camera access is still disabled in your browser site settings.',
    settingsActionTitle: 'Check camera access',
    settingsActionHint: 'Checks whether camera permission is enabled for this site.',
    openedSettingsMessage: '',
    openSettingsError: ''
} as const;

/** Checks browser camera availability and treats unsupported or failed preflight checks as unavailable. */
export async function isBarcodeCameraAvailable(): Promise<boolean> {
    try {
        return await CameraView.isAvailableAsync();
    } catch {
        return false;
    }
}

/** Browser permission settings remain browser-owned, so callers refresh the permission snapshot. */
export async function openBarcodeCameraSettings(): Promise<boolean> {
    return false;
}
