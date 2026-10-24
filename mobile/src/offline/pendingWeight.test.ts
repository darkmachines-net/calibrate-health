/** @file Regression coverage for pending Weight: pending weight mutation safety. */

import { hasPendingWeightMutation } from './pendingWeight';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'pending-weight-operation') }));

describe('pending weight mutation safety', () => {
    it.each(['metric.add', 'metric.delete'])('suppresses server calorie outputs for %s', (operation) => {
        expect(hasPendingWeightMutation([{ operation }])).toBe(true);
    });

    it('restores server calorie outputs only after the queue is empty', () => {
        expect(hasPendingWeightMutation([{ operation: 'food.create' }])).toBe(false);
        expect(hasPendingWeightMutation([])).toBe(false);
    });
});
