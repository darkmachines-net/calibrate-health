/** @file Regression coverage for device Locale: browser and runtime locale preferences. */

import { readRuntimeLocale } from './deviceLocale.shared';
import { getDeviceLocale } from './deviceLocale.web';

describe('browser and runtime locale preferences', () => {
    it('prefers the first browser language over the Intl formatting locale', () => {
        expect(readRuntimeLocale({ languages: ['en-GB', 'fr-FR'], language: 'fr-FR' }, () => 'en-US'))
            .toEqual({ languageTag: 'en-GB', regionCode: null, measurementSystem: null });
    });

    it('falls back through navigator.language, Intl, and an unknown locale', () => {
        expect(readRuntimeLocale({ language: 'fr-CA' }, () => 'en-US').languageTag).toBe('fr-CA');
        expect(readRuntimeLocale(null, () => 'en-US').languageTag).toBe('en-US');
        expect(readRuntimeLocale(null, () => { throw new Error('Intl unavailable'); }).languageTag).toBeNull();
    });

    it('uses the same safe runtime fallback on the web', () => {
        expect(getDeviceLocale(null, () => 'en-CA')).toEqual({ languageTag: 'en-CA', regionCode: null, measurementSystem: null });
    });
});
