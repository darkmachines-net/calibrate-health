/** @file Regression coverage for timezones: mobile timezone presentation. */

import {
    detectDeviceTimeZone,
    formatTimeZoneClock,
    formatTimeZoneLabel,
    getTimeZoneOptions,
    isValidIanaTimeZone,
    resolveOnboardingTimeZone
} from './timezones';

describe('mobile timezone presentation', () => {
    it('detects a valid device timezone without location access and fails safely', () => {
        expect(detectDeviceTimeZone(() => 'America/Los_Angeles')).toBe('America/Los_Angeles');
        expect(detectDeviceTimeZone(() => 'Not/A_Timezone')).toBeNull();
        expect(detectDeviceTimeZone(() => { throw new Error('Intl unavailable'); })).toBeNull();
    });

    it('suggests the device zone for untouched profiles but preserves started profiles', () => {
        expect(resolveOnboardingTimeZone('UTC', 'America/Los_Angeles', false)).toBe('America/Los_Angeles');
        expect(resolveOnboardingTimeZone('America/New_York', 'America/Los_Angeles', true)).toBe('America/New_York');
        expect(resolveOnboardingTimeZone('Invalid/Zone', null, false)).toBe('UTC');
    });

    it('validates timezone identifiers using the same Intl behavior as the backend', () => {
        expect(isValidIanaTimeZone('Europe/London')).toBe(true);
        expect(isValidIanaTimeZone('UTC')).toBe(true);
        expect(isValidIanaTimeZone('Mars/Olympus_Mons')).toBe(false);
        expect(isValidIanaTimeZone('')).toBe(false);
    });

    it('builds readable, deduplicated options with device and selected context', () => {
        const now = new Date('2026-01-15T12:00:00.000Z');
        const options = getTimeZoneOptions('America/Indiana/Indianapolis', 'America/Los_Angeles', now);

        expect(options[0]).toEqual(expect.objectContaining({
            value: 'America/Los_Angeles',
            label: 'Pacific Time (Los Angeles)'
        }));
        expect(options[0]?.description).toContain('Device time zone');
        expect(options[0]?.description).toContain('GMT-8');
        expect(options[1]).toEqual(expect.objectContaining({
            value: 'America/Indiana/Indianapolis',
            label: 'Indianapolis (America / Indiana)'
        }));
        expect(options[1]?.description).toContain('Selected');
        expect(new Set(options.map(({ value }) => value)).size).toBe(options.length);
    });

    it('formats labels and current clock details for display', () => {
        expect(formatTimeZoneLabel('Asia/Tokyo')).toBe('Japan (Tokyo)');
        expect(formatTimeZoneLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires (America / Argentina)');
        expect(formatTimeZoneClock('UTC', new Date('2026-01-15T12:00:00.000Z'))).toContain('12:00 PM');
        expect(formatTimeZoneClock('invalid')).toBeNull();
    });
});
