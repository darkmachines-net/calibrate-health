/** @file Regression coverage for input: weight entry input helpers. */

import {
    formatWeightInput,
    getWeightDisplayBounds,
    isWeightWithinPolicy,
    isWeightOutlier,
    normalizeWeightInputText,
    parseWeightInput
} from './input';

describe('weight entry input helpers', () => {
    it('accepts comma decimals and keeps the stored tenth-unit precision visible', () => {
        expect(normalizeWeightInputText('170,5')).toBe('170.5');
        expect(normalizeWeightInputText('170.56')).toBe('170.5');
        expect(parseWeightInput('170,5')).toBe(170.5);
        expect(formatWeightInput(170.04)).toBe('170');
    });

    it('rejects blank, zero, and non-numeric values', () => {
        expect(parseWeightInput('')).toBeNull();
        expect(parseWeightInput('.')).toBeNull();
        expect(parseWeightInput('0')).toBeNull();
    });

    it('soft-checks either a natural-unit jump or a ten-percent jump', () => {
        expect(isWeightOutlier({ value: 180, previousValue: 170, unit: 'LB' })).toBe(true);
        expect(isWeightOutlier({ value: 75, previousValue: 80, unit: 'KG' })).toBe(true);
        expect(isWeightOutlier({ value: 109, previousValue: 100, unit: 'LB' })).toBe(false);
        expect(isWeightOutlier({ value: 70, previousValue: null, unit: 'KG' })).toBe(false);
    });

    it('enforces exact kilogram display boundaries', () => {
        expect(isWeightWithinPolicy(24.9, 'KG')).toBe(false);
        expect(isWeightWithinPolicy(25, 'KG')).toBe(true);
        expect(isWeightWithinPolicy(400, 'KG')).toBe(true);
        expect(isWeightWithinPolicy(400.1, 'KG')).toBe(false);
        expect(getWeightDisplayBounds('KG')).toEqual({ minimum: 25, maximum: 400 });
    });

    it('enforces canonical grams after pound tenth rounding', () => {
        expect(isWeightWithinPolicy(55.1, 'LB')).toBe(false);
        expect(isWeightWithinPolicy(55.2, 'LB')).toBe(true);
        expect(isWeightWithinPolicy(881.8, 'LB')).toBe(true);
        expect(isWeightWithinPolicy(881.9, 'LB')).toBe(false);
        expect(getWeightDisplayBounds('LB')).toEqual({ minimum: 55.2, maximum: 881.8 });
    });
});
