/** @file Regression coverage for pending Calibration Evidence: pending calibration evidence mutations. */

import { OFFLINE_MUTATION_OPERATIONS } from './operations';
import {
    hasPendingCalibrationEvidenceMutation,
    isCalibrationEvidenceMutationOperation
} from './pendingCalibrationEvidence';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'generated-operation-id') }));

describe('pending calibration evidence mutations', () => {
    it.each(Object.values(OFFLINE_MUTATION_OPERATIONS))(
        'treats %s as calibration evidence',
        (operation) => {
            expect(isCalibrationEvidenceMutationOperation(operation)).toBe(true);
            expect(hasPendingCalibrationEvidenceMutation([{ operation }])).toBe(true);
        }
    );

    it('does not block calibration for unknown future operations or an empty outbox', () => {
        expect(isCalibrationEvidenceMutationOperation('unrelated.future-operation')).toBe(false);
        expect(hasPendingCalibrationEvidenceMutation([{ operation: 'unrelated.future-operation' }])).toBe(false);
        expect(hasPendingCalibrationEvidenceMutation([])).toBe(false);
    });
});
