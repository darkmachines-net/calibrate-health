/** @file device Locale: Older installed binaries can receive this bundle before they include Expo Localization. */

import { readRuntimeLocale, type DeviceLocale } from './deviceLocale.shared';

export type { DeviceLocale } from './deviceLocale.shared';

type LocalizationModule = { getLocales: () => DeviceLocale[] };

/** Older installed binaries can receive this bundle before they include Expo Localization. */
export function getDeviceLocale(): DeviceLocale {
    try {
        const { requireOptionalNativeModule } = require('expo') as typeof import('expo');
        const localization = requireOptionalNativeModule<LocalizationModule>('ExpoLocalization');
        const locale = localization?.getLocales()[0];
        if (locale) return locale;
    } catch {
        // Locale defaults remain available even when the optional platform module cannot load.
    }
    return readRuntimeLocale(null);
}
