/** @file Regression coverage for serialized token persistence and configured-backend credential isolation. */

const mockValues = new Map<string, string>();
let mockHold: Promise<void> | undefined;
jest.mock('expo-secure-store', () => ({
    getItemAsync: jest.fn(async (key: string) => mockValues.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { if (value.startsWith('old')) await mockHold; mockValues.set(key, value); }),
    deleteItemAsync: jest.fn(async (key: string) => { mockValues.delete(key); })
}));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { clearStoredTokens, readStoredTokens, writeStoredTokens } from './storage';

const SERVER_URL = 'https://calibratehealth.app';
const SERVER_URL_KEY = 'calibrate.mobile.serverUrl';
const TOKENS = { accessToken: 'stored-access', refreshToken: 'stored-refresh' };

beforeEach(async () => {
    jest.clearAllMocks();
    mockValues.clear();
    mockHold = undefined;
    await AsyncStorage.clear();
});

it('orders an in-flight old token write before logout clearing and replacement-account persistence', async () => {
    await AsyncStorage.setItem(SERVER_URL_KEY, SERVER_URL);
    let release!: () => void;
    mockHold = new Promise(resolve => { release = resolve; });
    const oldWrite = writeStoredTokens({ accessToken: 'old-access', refreshToken: 'old-refresh' });
    const logout = clearStoredTokens();
    const replacement = writeStoredTokens({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    const read = readStoredTokens(SERVER_URL);
    release();
    await Promise.all([oldWrite, logout, replacement]);
    await expect(read).resolves.toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    await clearStoredTokens();
    await expect(readStoredTokens(SERVER_URL)).resolves.toEqual({ accessToken: null, refreshToken: null });
});

it.each([SERVER_URL, `${SERVER_URL}/`])('restores credentials already bound to %s', async (storedOrigin) => {
    await AsyncStorage.setItem(SERVER_URL_KEY, storedOrigin);
    await writeStoredTokens(TOKENS);

    await expect(readStoredTokens(SERVER_URL)).resolves.toEqual(TOKENS);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
});

it.each(['https://previous.example', null, 'invalid origin'])('discards legacy credentials from %s before recording the configured backend', async (storedOrigin) => {
    if (storedOrigin) await AsyncStorage.setItem(SERVER_URL_KEY, storedOrigin);
    await writeStoredTokens(TOKENS);

    await expect(readStoredTokens(SERVER_URL)).resolves.toEqual({ accessToken: null, refreshToken: null });
    expect(await AsyncStorage.getItem(SERVER_URL_KEY)).toBe(SERVER_URL);
    await writeStoredTokens({ accessToken: 'configured-access', refreshToken: 'configured-refresh' });
    await expect(readStoredTokens(SERVER_URL)).resolves.toEqual({ accessToken: 'configured-access', refreshToken: 'configured-refresh' });
});

it('does not carry credentials across a later build configuration change', async () => {
    await readStoredTokens(SERVER_URL);
    await writeStoredTokens(TOKENS);

    await expect(readStoredTokens('https://build.example')).resolves.toEqual({ accessToken: null, refreshToken: null });
    expect(await AsyncStorage.getItem(SERVER_URL_KEY)).toBe('https://build.example');
});

it('does not reassign old credentials when their removal fails', async () => {
    await AsyncStorage.setItem(SERVER_URL_KEY, 'https://previous.example');
    await writeStoredTokens(TOKENS);
    jest.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('Storage unavailable'));

    await expect(readStoredTokens(SERVER_URL)).rejects.toThrow('Storage unavailable');
    expect(await AsyncStorage.getItem(SERVER_URL_KEY)).toBe('https://previous.example');
    await expect(readStoredTokens(SERVER_URL)).resolves.toEqual({ accessToken: null, refreshToken: null });
});
