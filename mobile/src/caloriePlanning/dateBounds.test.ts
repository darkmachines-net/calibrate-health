/** @file Regression coverage for date Bounds: date-of-birth picker bounds. */

import { getMinimumDateOfBirth } from './dateBounds';

describe('date-of-birth picker bounds', () => {
    it('starts on the day after the 121-years-prior anniversary', () => {
        expect(getMinimumDateOfBirth('2026-08-08')).toBe('1905-08-09');
    });

    it('uses the clamped anniversary for leap-day local dates', () => {
        expect(getMinimumDateOfBirth('2024-02-29')).toBe('1903-03-01');
    });

    it('fails closed for malformed local dates', () => {
        expect(getMinimumDateOfBirth('')).toBe('');
        expect(getMinimumDateOfBirth('not-a-date')).toBe('');
    });
});
