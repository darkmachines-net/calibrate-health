/** @file Regression coverage for dates: mobile local-day handling. */

import {
    addDaysToDateOnly,
    getLocalDateForTimestamp
} from './dates';

describe('mobile local-day handling', () => {
    it('keeps spring-forward timestamps on the correct Los Angeles calendar day', () => {
        expect(getLocalDateForTimestamp('2026-03-08T07:30:00.000Z', 'America/Los_Angeles'))
            .toBe('2026-03-07');
        expect(getLocalDateForTimestamp('2026-03-08T10:30:00.000Z', 'America/Los_Angeles'))
            .toBe('2026-03-08');
    });

    it('maps both repeated fall-back hours to the same calendar day', () => {
        expect(getLocalDateForTimestamp('2026-11-01T08:30:00.000Z', 'America/Los_Angeles'))
            .toBe('2026-11-01');
        expect(getLocalDateForTimestamp('2026-11-01T09:30:00.000Z', 'America/Los_Angeles'))
            .toBe('2026-11-01');
    });

    it('re-groups a timestamp when the profile timezone changes', () => {
        const timestamp = '2026-07-11T01:00:00.000Z';
        expect(getLocalDateForTimestamp(timestamp, 'America/Los_Angeles')).toBe('2026-07-10');
        expect(getLocalDateForTimestamp(timestamp, 'Asia/Tokyo')).toBe('2026-07-11');
    });

    it('advances date-only values by calendar day without DST-hour arithmetic', () => {
        expect(addDaysToDateOnly('2026-03-07', 1)).toBe('2026-03-08');
        expect(addDaysToDateOnly('2026-03-08', 1)).toBe('2026-03-09');
        expect(addDaysToDateOnly('2026-10-31', 1)).toBe('2026-11-01');
        expect(addDaysToDateOnly('2026-11-01', 1)).toBe('2026-11-02');
    });
});
