/** @file Regression coverage for storage: orders an in-flight old token write before logout clearing and replacement-account persistence. */

const mockValues = new Map<string, string>();
let mockHold: Promise<void> | undefined;
jest.mock('expo-secure-store', () => ({
    getItemAsync: jest.fn(async (key: string) => mockValues.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { if (value.startsWith('old')) await mockHold; mockValues.set(key, value); }),
    deleteItemAsync: jest.fn(async (key: string) => { mockValues.delete(key); })
}));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('../config/server', () => ({ getConfiguredServerUrl: jest.fn(), getDefaultServerUrl: jest.fn(), resolveInitialServerUrl: jest.fn() }));
import { clearStoredTokens, readStoredTokens, writeStoredTokens } from './storage';

it('orders an in-flight old token write before logout clearing and replacement-account persistence', async () => {
    let release!: () => void;
    mockHold = new Promise(resolve => { release = resolve; });
    const oldWrite = writeStoredTokens({ accessToken: 'old-access', refreshToken: 'old-refresh' });
    const logout = clearStoredTokens();
    const replacement = writeStoredTokens({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    const read = readStoredTokens();
    release();
    await Promise.all([oldWrite, logout, replacement]);
    await expect(read).resolves.toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    await clearStoredTokens();
    await expect(readStoredTokens()).resolves.toEqual({ accessToken: null, refreshToken: null });
});
