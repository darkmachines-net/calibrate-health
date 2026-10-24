/** @file language: Supported language codes for UI preferences. */

/**
 * Supported language codes for UI preferences.
 */
export const SUPPORTED_LANGUAGES = {
  EN: 'en',
  ES: 'es',
  FR: 'fr',
  RU: 'ru',
} as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[keyof typeof SUPPORTED_LANGUAGES];

/**
 * Type guard for supported UI language preference values.
 */
export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return (
    value === SUPPORTED_LANGUAGES.EN ||
    value === SUPPORTED_LANGUAGES.ES ||
    value === SUPPORTED_LANGUAGES.FR ||
    value === SUPPORTED_LANGUAGES.RU
  );
}
