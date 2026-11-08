/** @file Exclude native provider SDKs from browser bundles; browser account actions continue using password reauthentication. */
import type { SocialAuthProvider } from '@calibrate/shared/socialAuth';
import type { NativeProviderCredential } from '@calibrate/api-client';

/** Browser sessions expose no native provider capabilities. */
export async function nativeSocialProviders(): Promise<SocialAuthProvider[]> { return []; }

/** Reject a native-only action without loading SDKs or collecting credentials. */
export async function acquireSocialCredential(_provider: SocialAuthProvider): Promise<NativeProviderCredential | null> {
    throw new Error('Native provider sign-in requires the mobile app.');
}
