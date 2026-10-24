/** @file Regression coverage for food Log Amount: food log snapshot amounts. */

import type { FoodLogEntry } from '@calibrate/api-client';
import { getFoodLogAmountText, getFoodLogEditableAmount } from './foodLogAmount';

const createEntry = (overrides: Partial<FoodLogEntry>): FoodLogEntry => ({
    id: 1,
    meal_period: 'DINNER',
    name: 'Test food',
    calories: 100,
    ...overrides
});

describe('food log snapshot amounts', () => {
    it('presents and edits a legacy fractional per-100g measure as whole grams', () => {
        const entry = createEntry({
            servings_consumed: 1.42,
            serving_size_quantity_snapshot: 1,
            serving_unit_label_snapshot: '100g',
            measure_label_snapshot: 'per 100g',
            grams_per_measure_snapshot: 100,
            measure_quantity_snapshot: 1.42,
            grams_total_snapshot: 142
        });

        const amount = getFoodLogEditableAmount(entry);
        expect(amount?.amount).toBe(142);
        expect(amount?.unitLabel).toBe('g');
        expect(amount?.toServings(142)).toBe(1.42);
        expect(getFoodLogAmountText(entry)).toBe('142 g');
    });

    it('formats real serving units and pluralizes their readable quantity', () => {
        const entry = createEntry({
            servings_consumed: 1.5,
            serving_size_quantity_snapshot: 1,
            serving_unit_label_snapshot: 'container'
        });

        expect(getFoodLogAmountText(entry)).toBe('1.5 containers');
    });

    it('accounts for the quantity represented by one saved serving', () => {
        const entry = createEntry({
            servings_consumed: 1,
            serving_size_quantity_snapshot: 2,
            serving_unit_label_snapshot: 'slice'
        });

        const amount = getFoodLogEditableAmount(entry);
        expect(amount?.amount).toBe(2);
        expect(amount?.toServings(3)).toBe(1.5);
        expect(getFoodLogAmountText(entry)).toBe('2 slices');
    });

    it('keeps compound unit symbols invariant and pluralizes the final word of readable units', () => {
        expect(getFoodLogAmountText(createEntry({
            servings_consumed: 1,
            serving_size_quantity_snapshot: 8,
            serving_unit_label_snapshot: 'fl oz'
        }))).toBe('8 fl oz');
        expect(getFoodLogAmountText(createEntry({
            servings_consumed: 2,
            serving_size_quantity_snapshot: 1,
            serving_unit_label_snapshot: 'large slice'
        }))).toBe('2 large slices');
    });

    it('displays a grams-total-only legacy snapshot without offering an unsafe amount conversion', () => {
        const entry = createEntry({ grams_total_snapshot: 142 });
        expect(getFoodLogEditableAmount(entry)).toBeNull();
        expect(getFoodLogAmountText(entry)).toBe('142 g');
    });

    it('falls back to a serving label when no unit snapshot exists', () => {
        expect(getFoodLogAmountText(createEntry({ servings_consumed: 2 }))).toBe('2 servings');
    });
});
