/** @file Acquire short-lived native provider credentials; Firebase and Calibrate session ownership remain on the server. */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { SOCIAL_AUTH_PROVIDERS, type SocialAuthProvider } from '@calibrate/shared/socialAuth';
import type { MobileSocialAuthRequest } from '@calibrate/api-client';

type ProviderCredential = Pick<MobileSocialAuthRequest, 'provider' | 'id_token' | 'nonce'>;

/** Filter server capabilities against this build's Google configuration and Apple's device availability. */
export async function nativeSocialProviders(): Promise<SocialAuthProvider[]> {
    const providers: SocialAuthProvider[] = [];
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return providers;
    if (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID &&
        (Platform.OS === 'android' || Constants.expoConfig?.extra?.googleIosClientId)) {
        providers.push(SOCIAL_AUTH_PROVIDERS.GOOGLE);
    }
    if (Platform.OS === 'ios') {
        // Resolve native SDKs only when needed, keeping session restoration independent of provider prompts.
        const apple: typeof import('expo-apple-authentication') = require('expo-apple-authentication');
        if (await apple.isAvailableAsync()) providers.push(SOCIAL_AUTH_PROVIDERS.APPLE);
    }
    return providers;
}

/** Prompt interactively; return null on cancellation and never persist or log provider tokens. */
export async function acquireSocialCredential(provider: SocialAuthProvider): Promise<ProviderCredential | null> {
    if (!(await nativeSocialProviders()).includes(provider)) throw new Error('Provider unavailable on this device.');
    if (provider === SOCIAL_AUTH_PROVIDERS.GOOGLE) {
        const { GoogleSignin, isSuccessResponse, statusCodes }: typeof import('@react-native-google-signin/google-signin') = require('@react-native-google-signin/google-signin');
        GoogleSignin.configure({
            webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
            iosClientId: Constants.expoConfig?.extra?.googleIosClientId,
            offlineAccess: false
        });
        try {
            await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
            // Do not silently reuse the last Google account after Calibrate logout or a server switch.
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
    const apple: typeof import('expo-apple-authentication') = require('expo-apple-authentication');
    const Crypto: typeof import('expo-crypto') = require('expo-crypto');
    const nonce = Crypto.randomUUID().replaceAll('-', '') + Crypto.randomUUID().replaceAll('-', '');
    const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce);
    try {
        const result = await apple.signInAsync({ requestedScopes: [apple.AppleAuthenticationScope.EMAIL], nonce: hashedNonce });
        if (!result.identityToken) throw new Error('Provider did not return a credential.');
        return { provider, id_token: result.identityToken, nonce };
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_REQUEST_CANCELED') return null;
        throw error;
    }
}
