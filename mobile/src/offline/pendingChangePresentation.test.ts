/** @file Regression coverage for pending Change Presentation: durable pending tracking presentation. */

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
import { describePendingChange } from './pendingChangePresentation';

describe('durable pending tracking presentation', () => {
    it('shows the saved weigh-in value and date in the account display unit', () => {
        expect(describePendingChange({ operation: 'metric.add', payload: { date: '2026-07-21', weight: 87.9 } }, 'kg')).toEqual({ title: 'Weigh-in saved locally', details: ['Date: 2026-07-21', 'Weight: 87.9 kg'] });
    });
    it('shows locally created food and quantity without fabricating a server identity', () => {
        expect(describePendingChange({ operation: 'food.create', payload: { date: '2026-07-21', name: 'Synthetic oats', meal_period: 'BREAKFAST', calories: 320, servings_consumed: 2 } }, 'kg')).toEqual({ title: 'Food saved locally', details: ['Date: 2026-07-21', 'Food: Synthetic oats', 'Meal: BREAKFAST', 'Calories: 320 kcal', 'Servings: 2'] });
    });
    it('presents the actual queued food edits, including zero, rather than stale cached values', () => {
        expect(describePendingChange({ operation: 'food.update', payload: { id: 42, update: { name: 'Updated oats', calories: 0, servings_consumed: 1.5 } } }, 'kg')).toEqual({ title: 'Food edit pending', details: ['Food: Updated oats', 'Entry: 42', 'Calories: 0 kcal', 'Servings: 1.5'] });
    });
    it('does not expose arbitrary payload data or label a queued deletion as completed', () => {
        expect(describePendingChange({ operation: 'food.delete', payload: { id: 42, token: 'not for presentation' } }, 'kg')).toEqual({ title: 'Food deletion pending', details: ['Entry: 42'] });
    });
});
