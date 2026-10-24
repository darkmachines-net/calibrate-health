/** @file Regression coverage for device Locale native: native device locale preferences. */

jest.mock('expo', () => ({ requireOptionalNativeModule: jest.fn() }));
jest.mock('./deviceLocale.shared', () => ({
    readRuntimeLocale: jest.fn(() => ({ languageTag: 'en-US', regionCode: null, measurementSystem: null }))
}));

import { requireOptionalNativeModule } from 'expo';
import { readRuntimeLocale } from './deviceLocale.shared';
import { getDeviceLocale } from './deviceLocale.native';

describe('native device locale preferences', () => {
    beforeEach(() => jest.clearAllMocks());

    it('uses the device measurement preference rather than inferring from its language', () => {
        const preference = { languageTag: 'en-US', regionCode: 'US', measurementSystem: 'metric' };
        jest.mocked(requireOptionalNativeModule).mockReturnValue({ getLocales: () => [preference] });
        expect(getDeviceLocale()).toBe(preference);
        expect(requireOptionalNativeModule).toHaveBeenCalledWith('ExpoLocalization');
        expect(readRuntimeLocale).not.toHaveBeenCalled();
    });

    it.each([null, { getLocales: () => [] }, { getLocales: () => { throw new Error('Unavailable'); } }])(
        'keeps older or unavailable native modules working through Intl fallback', (module) => {
            jest.mocked(requireOptionalNativeModule).mockReturnValue(module);
            expect(getDeviceLocale().languageTag).toBe('en-US');
            expect(readRuntimeLocale).toHaveBeenCalledWith(null);
        }
    );

    it('falls back when the native-module lookup itself is unavailable', () => {
        jest.mocked(requireOptionalNativeModule).mockImplementationOnce(() => { throw new Error('Native host unavailable'); });
        expect(getDeviceLocale().languageTag).toBe('en-US');
    });
});
