/** @file pending Calibration Evidence: Identify queued writes that can change calibration evidence or its eligible window. */

import { OFFLINE_MUTATION_OPERATIONS } from './operations';
import type { QueuedMutation } from './queuedMutation';

const CALIBRATION_EVIDENCE_MUTATION_OPERATIONS = new Set<string>([
    OFFLINE_MUTATION_OPERATIONS.CREATE_FOOD_LOG,
    OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_LOG,
    OFFLINE_MUTATION_OPERATIONS.DELETE_FOOD_LOG,
    OFFLINE_MUTATION_OPERATIONS.ADD_METRIC,
    OFFLINE_MUTATION_OPERATIONS.DELETE_METRIC,
    OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_DAY,
    OFFLINE_MUTATION_OPERATIONS.SET_FOOD_DAY_STATUS,
    OFFLINE_MUTATION_OPERATIONS.START_FOOD_TRACKING_PAUSE,
    OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_TRACKING_PAUSE,
    OFFLINE_MUTATION_OPERATIONS.RESUME_FOOD_TRACKING
]);

/** Identify queued writes that can change calibration evidence or its eligible window. */
export function isCalibrationEvidenceMutationOperation(operation: string): boolean {
    return CALIBRATION_EVIDENCE_MUTATION_OPERATIONS.has(operation);
}

/** Reports queued operations that could change calibration evidence before a recommendation is applied. */
export function hasPendingCalibrationEvidenceMutation(
    mutations: ReadonlyArray<Pick<QueuedMutation, 'operation'>>
): boolean {
    return mutations.some(({ operation }) => isCalibrationEvidenceMutationOperation(operation));
}
