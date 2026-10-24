/** @file Regression coverage for quantity Input: food quantity input. */

import { getFoodQuantityStep } from './quantityInput';

describe('food quantity input', () => {
    it.each([
        ['g', 1],
        ['ml', 1],
        ['kg', 0.01],
        ['cup', 0.25],
        ['fl oz', 0.25],
        ['serving', 0.25],
        ['container', 0.5],
        ['custom unit', 0.1]
    ])('uses a practical step for %s', (unit, expectedStep) => {
        expect(getFoodQuantityStep(unit)).toBe(expectedStep);
    });
});
