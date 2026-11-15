/** @file Native Google credential coverage for platform support, cancellation and account choice. */
import { Platform } from 'react-native';
import { acquireSocialCredential, supportsNativeGoogleSignIn } from './nativeSocialAuth';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import Constants from 'expo-constants';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { googleIosClientId: 'ios-dev.apps.googleusercontent.com' } } } }));

jest.mock('@react-native-google-signin/google-signin', () => ({
    GoogleSignin: { configure: jest.fn(), hasPlayServices: jest.fn(), signIn: jest.fn(), signOut: jest.fn(async () => undefined) },
    isSuccessResponse: (response: { type: string }) => response.type === 'success',
    statusCodes: { SIGN_IN_CANCELLED: 'CANCELLED' }
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
test('a configured build offers Google on iOS and Android', () => {
    expect(supportsNativeGoogleSignIn()).toBe(true);
    jest.replaceProperty(Platform, 'OS', 'android');
    expect(supportsNativeGoogleSignIn()).toBe(true);
    delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    expect(supportsNativeGoogleSignIn()).toBe(false);
});
test('Google prompts interactively and clears SDK state after obtaining an ephemeral token', async () => {
    jest.mocked(GoogleSignin.signIn).mockResolvedValue({ type: 'success', data: { idToken: 'google-token' } } as never);
    expect(await acquireSocialCredential('google.com')).toEqual({ provider: 'google.com', id_token: 'google-token' });
    expect(GoogleSignin.configure).toHaveBeenCalledWith(expect.objectContaining({ webClientId: 'web.apps.googleusercontent.com', iosClientId: 'ios-dev.apps.googleusercontent.com', offlineAccess: false }));
    expect(GoogleSignin.signOut).toHaveBeenCalledTimes(2);
});
test('iOS requires the client selected for its bundle instead of falling back to a store environment ID', () => {
    jest.replaceProperty(Constants.expoConfig!.extra!, 'googleIosClientId', undefined);
    expect(supportsNativeGoogleSignIn()).toBe(false);
});
test('Google cancellation does not produce a token or error', async () => {
    jest.mocked(GoogleSignin.signIn).mockResolvedValue({ type: 'cancelled', data: null } as never);
    expect(await acquireSocialCredential('google.com')).toBeNull();
});
test('legacy Apple input cannot open a provider prompt on a current iOS build', async () => {
    await expect(acquireSocialCredential('apple.com')).rejects.toThrow('Provider unavailable on this device.');
    expect(GoogleSignin.signIn).not.toHaveBeenCalled();
});
