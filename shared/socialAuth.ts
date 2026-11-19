/** @file Provider identifiers shared by native credential acquisition and Firebase session exchange. */

export const SOCIAL_AUTH_PROVIDERS = {
    GOOGLE: 'google.com'
} as const;

export type SocialAuthProvider = typeof SOCIAL_AUTH_PROVIDERS[keyof typeof SOCIAL_AUTH_PROVIDERS];

/** Recognize the Google provider ID used by Calibrate's native sign-in flow. */
export function isSocialAuthProvider(value: unknown): value is SocialAuthProvider {
    return value === SOCIAL_AUTH_PROVIDERS.GOOGLE;
}
