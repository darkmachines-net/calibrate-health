/** @file Acquire short-lived Google credentials on native phones for server-side Firebase exchange. */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { SOCIAL_AUTH_PROVIDERS, type SocialAuthProvider } from '@calibrate/shared/socialAuth';
import type { MobileSocialAuthRequest } from '@calibrate/api-client';

type ProviderCredential = Pick<MobileSocialAuthRequest, 'provider' | 'id_token'>;

/** Check whether the native build has the Google client IDs for its platform. */
export function supportsNativeGoogleSignIn(): boolean {
    if (!process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID) return false;
    return Platform.OS === 'android' || (Platform.OS === 'ios' && Boolean(Constants.expoConfig?.extra?.googleIosClientId));
}

/** Prompt for Google on supported builds, returning null on cancellation and keeping the token ephemeral. */
export async function acquireSocialCredential(provider: SocialAuthProvider): Promise<ProviderCredential | null> {
    if (provider !== SOCIAL_AUTH_PROVIDERS.GOOGLE || !supportsNativeGoogleSignIn()) {
        throw new Error('Provider unavailable on this device.');
    }
    const { GoogleSignin, isSuccessResponse, statusCodes }: typeof import('@react-native-google-signin/google-signin') = require('@react-native-google-signin/google-signin');
    GoogleSignin.configure({
        webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
        iosClientId: Constants.expoConfig?.extra?.googleIosClientId,
        offlineAccess: false
    });
    try {
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
        // Do not silently reuse the last Google account after Calibrate logout.
        await GoogleSignin.signOut();
        const result = await GoogleSignin.signIn();
        if (!isSuccessResponse(result)) return null;
        if (!result.data.idToken) throw new Error('Provider did not return a credential.');
        return { provider, id_token: result.data.idToken };
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === statusCodes.SIGN_IN_CANCELLED) return null;
        throw error;
    } finally {
        await GoogleSignin.signOut().catch(() => undefined);
    }
}
