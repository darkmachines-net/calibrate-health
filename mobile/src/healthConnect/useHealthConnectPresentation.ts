/** @file use Health Connect Presentation: Bind the pure shared presentation contract to the active Health Connect provider. */

import { useMemo } from 'react';
import { getHealthConnectPresentation } from './presentation';
import { useHealthConnect } from './provider';

export type UseHealthConnectPresentationOptions = {
    hasImportedActivity?: boolean;
    now?: Date;
};

/** Bind the pure shared presentation contract to the active Health Connect provider. */
export function useHealthConnectPresentation({
    hasImportedActivity = false,
    now
}: UseHealthConnectPresentationOptions = {}) {
    const healthConnect = useHealthConnect();
    return useMemo(() => getHealthConnectPresentation({
        availability: healthConnect.connection?.availability,
        connected: healthConnect.connected,
        paused: healthConnect.paused,
        isLoading: healthConnect.isLoading,
        isSyncing: healthConnect.isSyncing,
        error: healthConnect.error,
        syncError: healthConnect.syncError,
        selection: healthConnect.selection,
        grantedFeatures: healthConnect.connection?.grantedFeatures,
        hasImportedActivity,
        lastSuccessfulSyncAt: healthConnect.lastSuccessfulSyncAt,
        now
    }), [hasImportedActivity, healthConnect, now]);
}
