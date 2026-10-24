/** @file Account/server-scoped Health Connect opt-ins, connection preferences, and durable synchronization checkpoints. */

import {
    DEFAULT_HEALTH_CONNECT_SELECTION,
    HEALTH_CONNECT_FEATURES,
    type HealthConnectFeatureSelection
} from './types';
import { healthConnectAccountScope } from './storageScope';

const STORAGE_KEY_PREFIX = '@calibrate/health-connect/preferences/v1';
const LAST_SUCCESS_STORAGE_KEY_PREFIX = '@calibrate/health-connect/last-success/v1';

export type StoredHealthConnectPreferences = {
    connected: boolean;
    paused: boolean;
    selection: HealthConnectFeatureSelection;
};

export const DEFAULT_HEALTH_CONNECT_PREFERENCES: StoredHealthConnectPreferences = {
    connected: false,
    paused: false,
    selection: DEFAULT_HEALTH_CONNECT_SELECTION
};

/** Builds a preference key isolated by canonical server origin and account identifier. */
export function healthConnectPreferencesStorageKey(serverUrl: string, userId: number): string {
    return `${STORAGE_KEY_PREFIX}/${healthConnectAccountScope(serverUrl, userId)}`;
}

/** Builds an account-scoped key for the last successful Health Connect synchronization time. */
export function healthConnectLastSuccessStorageKey(serverUrl: string, userId: number): string {
    return `${LAST_SUCCESS_STORAGE_KEY_PREFIX}/${healthConnectAccountScope(serverUrl, userId)}`;
}

/** Safely hydrate preferences written by older or interrupted app versions. */
export function parseStoredHealthConnectPreferences(value: string | null): StoredHealthConnectPreferences {
    if (!value) return DEFAULT_HEALTH_CONNECT_PREFERENCES;

    try {
        const parsed = JSON.parse(value) as Partial<StoredHealthConnectPreferences>;
        const rawSelection = parsed.selection as Partial<HealthConnectFeatureSelection> | undefined;
        const selection = { ...DEFAULT_HEALTH_CONNECT_SELECTION };
        for (const feature of Object.values(HEALTH_CONNECT_FEATURES)) {
            const storedValue = rawSelection?.[feature];
            if (typeof storedValue === 'boolean') selection[feature] = storedValue;
        }
        return {
            connected: typeof parsed.connected === 'boolean' ? parsed.connected : false,
            paused: typeof parsed.paused === 'boolean' ? parsed.paused : false,
            selection
        };
    } catch {
        return DEFAULT_HEALTH_CONNECT_PREFERENCES;
    }
}
