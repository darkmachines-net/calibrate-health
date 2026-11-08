/** @file Serialized native credentials, bound to the configured backend before session restoration. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { normalizeServerUrl } from '../config/server';

const ACCESS_TOKEN_KEY = 'calibrate.mobile.accessToken';
const REFRESH_TOKEN_KEY = 'calibrate.mobile.refreshToken';
const DEVICE_ID_KEY = 'calibrate.mobile.deviceId';
const SERVER_URL_KEY = 'calibrate.mobile.serverUrl';

export type StoredTokens = {
    accessToken: string | null;
    refreshToken: string | null;
};

let tokenUpdates: Promise<unknown> = Promise.resolve();
function serializeTokens<T>(work: () => Promise<T>): Promise<T> {
    const task = tokenUpdates.then(work);
    tokenUpdates = task.catch(() => undefined);
    return task;
}

/**
 * Restores credentials only for the configured origin. The legacy server preference now
 * records credential ownership; mismatched or unscoped credentials are removed before
 * that marker changes. Storage failures reject startup without releasing any tokens.
 */
export async function readStoredTokens(serverUrl: string): Promise<StoredTokens> {
    return serializeTokens(async () => {
        const storedServerUrl = await AsyncStorage.getItem(SERVER_URL_KEY);
        if (!storedServerUrl || normalizeServerUrl(storedServerUrl) !== serverUrl) {
            await Promise.all([
                SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
                SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY)
            ]);
        }
        await AsyncStorage.setItem(SERVER_URL_KEY, serverUrl);
        const [accessToken, refreshToken] = await Promise.all([
            SecureStore.getItemAsync(ACCESS_TOKEN_KEY),
            SecureStore.getItemAsync(REFRESH_TOKEN_KEY)
        ]);
        return { accessToken, refreshToken };
    });
}

/** Serializes persistence of the access and refresh credential pair in secure storage. */
export async function writeStoredTokens(tokens: { accessToken: string; refreshToken: string }): Promise<void> {
    await serializeTokens(() => Promise.all([
        SecureStore.setItemAsync(ACCESS_TOKEN_KEY, tokens.accessToken),
        SecureStore.setItemAsync(REFRESH_TOKEN_KEY, tokens.refreshToken)
    ]));
}

/** Serializes removal of both native authentication credentials from secure storage. */
export async function clearStoredTokens(): Promise<void> {
    await serializeTokens(() => Promise.all([
        SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
        SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY)
    ]));
}

/** Returns the persisted installation identifier, creating and storing one when absent. */
export async function getOrCreateDeviceId(): Promise<string> {
    const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (existing) {
        return existing;
    }

    const next = typeof Crypto.randomUUID === 'function'
        ? Crypto.randomUUID()
        : `native-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await SecureStore.setItemAsync(DEVICE_ID_KEY, next);
    return next;
}
