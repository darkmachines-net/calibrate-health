/** @file Regression coverage for height Input: display-unit height policy. */

import { HEIGHT_UNITS } from '@calibrate/shared';
import { heightInputToCanonicalMillimeters, isHeightWithinPolicy } from './heightInput';

describe('display-unit height policy', () => {
    it.each([
        [99.9, false],
        [100, true],
        [250, true],
        [250.1, false]
    ])('validates %s cm', (centimeters, expected) => {
        expect(isHeightWithinPolicy({ unit: HEIGHT_UNITS.CM, centimeters })).toBe(expected);
    });

    it.each([
        [3, 3, false],
        [3, 4, true],
        [8, 2, true],
        [8, 3, false]
    ])('validates %s ft %s in after canonical conversion', (feet, inches, expected) => {
        expect(isHeightWithinPolicy({ unit: HEIGHT_UNITS.FT_IN, feet, inches })).toBe(expected);
    });

    it('rounds display-unit input to the canonical millimeter boundary', () => {
        expect(heightInputToCanonicalMillimeters({
            unit: HEIGHT_UNITS.FT_IN,
            feet: 3,
            inches: 4
        })).toBe(1016);
        expect(heightInputToCanonicalMillimeters({
            unit: HEIGHT_UNITS.FT_IN,
            feet: 8,
            inches: 2
        })).toBe(2489);
    });
});
