/** @file Native provider credential coverage for platform support, cancellation, account choice and Apple nonce binding. */
import { Platform } from 'react-native';
import { acquireSocialCredential, nativeSocialProviders } from './nativeSocialAuth';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as Apple from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { googleIosClientId: 'ios-dev.apps.googleusercontent.com' } } } }));

jest.mock('@react-native-google-signin/google-signin', () => ({
    GoogleSignin: { configure: jest.fn(), hasPlayServices: jest.fn(), signIn: jest.fn(), signOut: jest.fn(async () => undefined) },
    isSuccessResponse: (response: { type: string }) => response.type === 'success',
    statusCodes: { SIGN_IN_CANCELLED: 'CANCELLED' }
}));
jest.mock('expo-apple-authentication', () => ({
    isAvailableAsync: jest.fn(async () => true), signInAsync: jest.fn(), AppleAuthenticationScope: { EMAIL: 0 }
}));
jest.mock('expo-crypto', () => ({
    randomUUID: jest.fn(() => '12345678-1234-1234-1234-123456789abc'),
    digestStringAsync: jest.fn(async () => 'hashed-nonce'), CryptoDigestAlgorithm: { SHA256: 'SHA-256' }
}));
const originalWebId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
const originalIosId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'web.apps.googleusercontent.com';
    process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = 'ios.apps.googleusercontent.com';
    jest.replaceProperty(Platform, 'OS', 'ios');
});
afterEach(() => {
    jest.restoreAllMocks();
    if (originalWebId === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    else process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = originalWebId;
    if (originalIosId === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
    else process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = originalIosId;
});
test('iOS offers both providers; Android never offers Apple', async () => {
    expect(await nativeSocialProviders()).toEqual(['google.com', 'apple.com']);
    jest.replaceProperty(Platform, 'OS', 'android');
    expect(await nativeSocialProviders()).toEqual(['google.com']);
    delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    expect(await nativeSocialProviders()).toEqual([]);
});
test('Google prompts interactively and clears SDK state after obtaining an ephemeral token', async () => {
    jest.mocked(GoogleSignin.signIn).mockResolvedValue({ type: 'success', data: { idToken: 'google-token' } } as never);
    expect(await acquireSocialCredential('google.com')).toEqual({ provider: 'google.com', id_token: 'google-token' });
    expect(GoogleSignin.configure).toHaveBeenCalledWith(expect.objectContaining({ webClientId: 'web.apps.googleusercontent.com', iosClientId: 'ios-dev.apps.googleusercontent.com', offlineAccess: false }));
    expect(GoogleSignin.signOut).toHaveBeenCalledTimes(2);
});
test('iOS requires the client selected for its bundle instead of falling back to a store environment ID', async () => {
    jest.replaceProperty(Constants.expoConfig!.extra!, 'googleIosClientId', undefined);
    expect(await nativeSocialProviders()).toEqual(['apple.com']);
});
test('Google cancellation does not produce a token or error', async () => {
    jest.mocked(GoogleSignin.signIn).mockResolvedValue({ type: 'cancelled', data: null } as never);
    expect(await acquireSocialCredential('google.com')).toBeNull();
});
test('Apple receives the nonce hash while Firebase receives its raw value; email is not taken from client metadata', async () => {
    jest.mocked(Apple.signInAsync).mockResolvedValue({ identityToken: 'apple-token', email: null } as never);
    const result = await acquireSocialCredential('apple.com');
    expect(result).toEqual({ provider: 'apple.com', id_token: 'apple-token', nonce: '12345678123412341234123456789abc'.repeat(2) });
    expect(Crypto.digestStringAsync).toHaveBeenCalledWith('SHA-256', result?.nonce);
    expect(Apple.signInAsync).toHaveBeenCalledWith({ requestedScopes: [0], nonce: 'hashed-nonce' });
});
test('Apple cancellation is quiet and missing credentials fail closed', async () => {
    jest.mocked(Apple.signInAsync).mockRejectedValueOnce({ code: 'ERR_REQUEST_CANCELED' });
    expect(await acquireSocialCredential('apple.com')).toBeNull();
    jest.mocked(Apple.signInAsync).mockResolvedValueOnce({ identityToken: null } as never);
    await expect(acquireSocialCredential('apple.com')).rejects.toThrow('Provider did not return');
});
