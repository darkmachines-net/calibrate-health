/** @file use Pending Calibration Evidence Mutation: Hide calibration actions until queued evidence writes replay and the server status refetches. */

import { useOfflineOutbox } from './provider';
import { hasPendingCalibrationEvidenceMutation } from './pendingCalibrationEvidence';

/** Hide calibration actions until queued evidence writes replay and the server status refetches. */
export function usePendingCalibrationEvidenceMutation(): boolean {
    return hasPendingCalibrationEvidenceMutation(useOfflineOutbox().mutations);
}
