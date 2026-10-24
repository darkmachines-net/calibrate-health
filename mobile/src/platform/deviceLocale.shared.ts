/** @file device Locale: Browsers expose preferred languages, while older native binaries still expose their Intl locale. */

import type { Locale } from 'expo-localization';

export type DeviceLocale = Pick<Locale, 'measurementSystem' | 'regionCode'> & { languageTag: string | null };

type BrowserLanguage = { languages?: readonly string[]; language?: string };

/** Browsers expose preferred languages, while older native binaries still expose their Intl locale. */
export function readRuntimeLocale(
    browser: BrowserLanguage | null = typeof navigator === 'undefined' ? null : navigator,
    resolveIntlLocale: () => string = () => Intl.DateTimeFormat().resolvedOptions().locale
): DeviceLocale {
    let languageTag = browser?.languages?.find((language) => Boolean(language.trim())) ?? browser?.language ?? null;
    if (!languageTag) {
        try { languageTag = resolveIntlLocale(); } catch { /* Keep an unknown locale rather than guessing a region. */ }
    }
    return { languageTag, measurementSystem: null, regionCode: null };
}
