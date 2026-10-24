/** @file account Cleanup: Best-effort remote watch erase followed by mandatory account-scoped phone coordination cleanup. */

import { clearWearHandoffStorage } from './handoff';
import {
    clearWearPairingStorage,
    readStoredWearPairing,
    sendWearAccountDisconnect
} from './pairing';
import { clearWearSyncInvalidation } from './syncInvalidation';

type WearCleanupDependencies = {
    readPairing: typeof readStoredWearPairing;
    sendDisconnect: typeof sendWearAccountDisconnect;
    clearPairing: typeof clearWearPairingStorage;
    clearInvalidation: typeof clearWearSyncInvalidation;
    clearHandoffs: typeof clearWearHandoffStorage;
};

/** Best-effort remote watch erase followed by mandatory account-scoped phone coordination cleanup. */
export async function clearWearAccountData(
    serverOrigin: string,
    userId: number,
    dependencies: WearCleanupDependencies = {
        readPairing: readStoredWearPairing,
        sendDisconnect: sendWearAccountDisconnect,
        clearPairing: clearWearPairingStorage,
        clearInvalidation: clearWearSyncInvalidation,
        clearHandoffs: clearWearHandoffStorage
    }
): Promise<void> {
    const pairingResult = await Promise.allSettled([dependencies.readPairing(serverOrigin, userId)]);
    const pairing = pairingResult[0].status === 'fulfilled' ? pairingResult[0].value : null;
    const watchResult = pairing
        ? await Promise.allSettled([dependencies.sendDisconnect({ pairing, userId })])
        : [];
    const localResults = await Promise.allSettled([
        dependencies.clearPairing(serverOrigin, userId),
        dependencies.clearInvalidation(serverOrigin, userId),
        dependencies.clearHandoffs(serverOrigin, userId)
    ]);

    if (localResults.some(({ status }) => status === 'rejected')) {
        throw new Error('Phone-side Wear pairing data could not be fully cleared. Clear Calibrate app data before signing in again.');
    }
    if (pairingResult[0].status === 'rejected') {
        throw new Error('Phone-side Wear pairing data could not be inspected before cleanup. Clear Calibrate app data before signing in again.');
    }
    if (watchResult.some(({ status }) => status === 'rejected')) {
        throw new Error('Paired watch was unreachable. Disconnect Calibrate on the watch.');
    }
}
