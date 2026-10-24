/** @file use App Update Controller: Combines Expo-owned update lifecycle state with manual check, download, and restart actions. */

import { useCallback, useMemo, useState } from 'react';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';
import {
    appUpdateRuntime,
    canManageOtaUpdates,
    checkForAppUpdate,
    downloadAppUpdate,
    getAppVersionInfo
} from './appUpdate';

type ManualUpdatePhase = 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'restarting' | 'error';

function updateFailureMessage(action: 'check' | 'install'): string {
    return action === 'check'
        ? "Couldn't check for updates. Check your connection and try again."
        : "Couldn't install the update. Check your connection and try again.";
}

/** Combines Expo-owned update lifecycle state with manual check, download, and restart actions. */
export function useAppUpdateController() {
    const updates = Updates.useUpdates();
    const isDevelopment = typeof __DEV__ !== 'undefined' && __DEV__;
    const isSupported = canManageOtaUpdates(Platform.OS, isDevelopment, Updates.isEnabled);
    const [manualPhase, setManualPhase] = useState<ManualUpdatePhase>('idle');
    const [manualStatus, setManualStatus] = useState<string | null>(null);
    const manuallyAvailable = manualPhase === 'available';
    const isUpdateAvailable = manuallyAvailable || updates.isUpdateAvailable;
    const isBusy = manualPhase === 'checking'
        || manualPhase === 'downloading'
        || manualPhase === 'restarting'
        || updates.isChecking
        || updates.isDownloading
        || updates.isRestarting;
    const versionInfo = useMemo(
        () => getAppVersionInfo(updates.currentlyRunning),
        [updates.currentlyRunning]
    );

    const check = useCallback(async () => {
        if (!isSupported || isBusy) return;
        setManualPhase('checking');
        setManualStatus('Checking the selected update channel...');
        try {
            const result = await checkForAppUpdate();
            if (result === 'current') {
                setManualPhase('current');
                setManualStatus("You're using the newest compatible update.");
                return;
            }
            setManualPhase('available');
            setManualStatus(result === 'rollback'
                ? 'A recovery update is available. Install it to return to the embedded version.'
                : 'A compatible OTA update is available and ready to download.');
        } catch {
            setManualPhase('error');
            setManualStatus(updateFailureMessage('check'));
        }
    }, [isBusy, isSupported]);

    const restart = useCallback(async () => {
        if (!isSupported || isBusy) return;
        setManualPhase('restarting');
        setManualStatus('Restarting Calibrate with the downloaded update...');
        try {
            await appUpdateRuntime.reloadAsync();
        } catch {
            setManualPhase('error');
            setManualStatus(updateFailureMessage('install'));
        }
    }, [isBusy, isSupported]);

    const install = useCallback(async () => {
        if (!isSupported || isBusy) return;
        setManualPhase('downloading');
        setManualStatus('Downloading and verifying the update...');
        try {
            const downloaded = await downloadAppUpdate();
            if (!downloaded) {
                setManualPhase('current');
                setManualStatus('That update is no longer available. Check again for the latest version.');
                return;
            }
            setManualPhase('restarting');
            setManualStatus('Update verified. Restarting Calibrate...');
            await appUpdateRuntime.reloadAsync();
        } catch {
            setManualPhase('error');
            setManualStatus(updateFailureMessage('install'));
        }
    }, [isBusy, isSupported]);

    let status = manualStatus;
    if (!status && Platform.OS === 'web') {
        status = 'Browser updates are installed through the Calibrate PWA lifecycle.';
    } else if (!status && !isSupported) {
        status = 'Manual OTA checks are available in signed release builds.';
    } else if (!status && updates.isUpdatePending) {
        status = 'An update is downloaded and ready. Restart to use it now.';
    } else if (!status && updates.isUpdateAvailable) {
        status = 'A compatible OTA update is available and ready to download.';
    } else if (!status) {
        status = 'Calibrate checks automatically when it opens. You can also check manually.';
    }

    let actionTitle = 'Check for updates';
    let action = check;
    if (!isSupported) actionTitle = Platform.OS === 'web' ? 'Browser-managed updates' : 'Release builds only';
    else if (updates.isUpdatePending) {
        actionTitle = 'Restart to update';
        action = restart;
    } else if (isUpdateAvailable) {
        actionTitle = 'Install and restart';
        action = install;
    } else if (manualPhase === 'checking' || updates.isChecking) actionTitle = 'Checking...';
    else if (manualPhase === 'downloading' || updates.isDownloading) actionTitle = 'Downloading...';
    else if (manualPhase === 'restarting' || updates.isRestarting) actionTitle = 'Restarting...';

    return {
        action,
        actionTitle,
        downloadProgress: updates.downloadProgress,
        isBusy,
        isSupported,
        isUpdateAvailable,
        isUpdatePending: updates.isUpdatePending,
        manualPhase,
        status,
        versionInfo
    };
}
