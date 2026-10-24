/** @file provider: Own per-account Health Connect consent choices without coupling them to server sync. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { hasFullAccountAccess } from '../auth/accountAccess';
import {
    disconnectHealthConnect,
    getHealthConnectConnection,
    openHealthConnectAccess,
    requestHealthConnectFeatures
} from './native';
import {
    type HealthConnectConnection,
    type HealthConnectFeature
} from './types';
import {
    DEFAULT_HEALTH_CONNECT_PREFERENCES,
    healthConnectLastSuccessStorageKey,
    healthConnectPreferencesStorageKey,
    parseStoredHealthConnectPreferences,
    type StoredHealthConnectPreferences
} from './preferences';
import {
    clearHealthConnectSyncStorage,
    getActionableHealthConnectSyncError,
    HealthConnectSyncCancelledError,
    synchronizeHealthConnect
} from './sync';
import { healthConnectAccountScope } from './storageScope';
import { queueWearSyncInvalidation } from '../wear/syncInvalidation';
import { clearHealthConnectAccountData } from './accountCleanup';
import { getSafeActionErrorMessage } from '../errors/presentation';

const HEALTH_CONNECT_PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata';

type HealthConnectContextValue = StoredHealthConnectPreferences & {
    connection: HealthConnectConnection | null;
    isLoading: boolean;
    isBusy: boolean;
    isSyncing: boolean;
    lastRefreshedAt: string | null;
    lastSuccessfulSyncAt: string | null;
    error: string | null;
    syncError: string | null;
    restartMessage: string | null;
    connect: () => Promise<void>;
    refresh: () => Promise<void>;
    sync: () => Promise<void>;
    setFeatureEnabled: (feature: HealthConnectFeature, enabled: boolean) => Promise<void>;
    setPaused: (paused: boolean) => Promise<void>;
    manageAccess: () => Promise<void>;
    updateProvider: () => Promise<void>;
    disconnect: () => Promise<void>;
    clearAccountData: () => Promise<void>;
};

const HealthConnectContext = createContext<HealthConnectContextValue | null>(null);

function errorMessage(error: unknown, fallback: string): string {
    return getSafeActionErrorMessage(error, fallback);
}

/** Own per-account Health Connect consent choices without coupling them to server sync. */
export function HealthConnectProvider({ children }: { children: React.ReactNode }) {
    const { api, serverUrl, user: authenticatedUser } = useAuth();
    const user = hasFullAccountAccess(authenticatedUser) ? authenticatedUser : null;
    const [preferences, setPreferences] = useState(DEFAULT_HEALTH_CONNECT_PREFERENCES);
    const [connection, setConnection] = useState<HealthConnectConnection | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isBusy, setIsBusy] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
    const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [syncError, setSyncError] = useState<string | null>(null);
    const [restartMessage, setRestartMessage] = useState<string | null>(null);
    const activeRun = useRef(0);
    const preferencesRef = useRef(preferences);
    const connectionRef = useRef<HealthConnectConnection | null>(connection);
    const syncPromiseRef = useRef<{ generation: number; promise: Promise<void> } | null>(null);
    const syncContext = user
        ? `${healthConnectAccountScope(serverUrl, user.id)}|${user.timezone || 'UTC'}`
        : null;
    const syncContextRef = useRef(syncContext);
    const syncGenerationRef = useRef(0);
    if (syncContextRef.current !== syncContext) {
        syncContextRef.current = syncContext;
        syncGenerationRef.current += 1;
    }

    useEffect(() => {
        preferencesRef.current = preferences;
    }, [preferences]);

    useEffect(() => {
        connectionRef.current = connection;
    }, [connection]);

    const persist = useCallback(async (next: StoredHealthConnectPreferences) => {
        if (!user) return;
        preferencesRef.current = next;
        setPreferences(next);
        await AsyncStorage.setItem(healthConnectPreferencesStorageKey(serverUrl, user.id), JSON.stringify(next));
    }, [serverUrl, user]);

    const runForegroundSync = useCallback(async (
        nextConnection: HealthConnectConnection | null = connectionRef.current
    ) => {
        const currentUser = user;
        const currentPreferences = preferencesRef.current;
        const currentSyncContext = syncContext;
        const generation = syncGenerationRef.current;
        if (
            !currentUser
            || !currentSyncContext
            || !currentPreferences.connected
            || currentPreferences.paused
            || !nextConnection?.initialized
            || nextConnection.availability !== 'available'
        ) return;
        if (syncPromiseRef.current?.generation === generation) {
            return syncPromiseRef.current.promise;
        }

        const shouldContinue = () => (
            syncGenerationRef.current === generation
            && syncContextRef.current === currentSyncContext
            && preferencesRef.current.connected
            && !preferencesRef.current.paused
        );

        const syncPromise = (async () => {
            setIsSyncing(true);
            setSyncError(null);
            try {
                const result = await synchronizeHealthConnect({
                    serverUrl,
                    userId: currentUser.id,
                    timeZone: currentUser.timezone || 'UTC',
                    selection: currentPreferences.selection,
                    grantedFeatures: nextConnection.grantedFeatures,
                    api,
                    shouldContinue
                });
                if (!shouldContinue()) return;
                setLastSuccessfulSyncAt(result.lastSuccessfulSyncAt);
                await AsyncStorage.setItem(
                    healthConnectLastSuccessStorageKey(serverUrl, currentUser.id),
                    result.lastSuccessfulSyncAt
                );
                if (!shouldContinue()) return;
                void queueWearSyncInvalidation({ serverOrigin: serverUrl, userId: currentUser.id });
                if (result.missingFeatures.length > 0) {
                    setSyncError(
                        `Some selected Health Connect access is missing (${result.missingFeatures.join(', ')}). Open Manage access to restore it.`
                    );
                }
            } catch (syncFailure) {
                if (!(syncFailure instanceof HealthConnectSyncCancelledError) && shouldContinue()) {
                    setSyncError(getActionableHealthConnectSyncError(syncFailure));
                }
            } finally {
                if (syncGenerationRef.current === generation) setIsSyncing(false);
            }
        })();
        syncPromiseRef.current = { generation, promise: syncPromise };
        try {
            await syncPromise;
        } finally {
            if (syncPromiseRef.current?.promise === syncPromise) syncPromiseRef.current = null;
        }
    }, [api, serverUrl, syncContext, user]);

    const refreshConnection = useCallback(async (): Promise<HealthConnectConnection | null> => {
        if (!user) return null;
        const run = ++activeRun.current;
        setIsBusy(true);
        try {
            const nextConnection = await getHealthConnectConnection();
            if (run !== activeRun.current) return null;
            setConnection(nextConnection);
            setLastRefreshedAt(new Date().toISOString());
            setError(null);
            return nextConnection;
        } catch (refreshError) {
            if (run === activeRun.current) {
                setError(errorMessage(refreshError, 'Unable to check Health Connect access. Try again.'));
            }
            return null;
        } finally {
            if (run === activeRun.current) setIsBusy(false);
        }
    }, [user]);

    const refresh = useCallback(async () => {
        await refreshConnection();
    }, [refreshConnection]);

    useEffect(() => {
        const run = ++activeRun.current;
        setIsLoading(true);
        setConnection(null);
        setLastRefreshedAt(null);
        setLastSuccessfulSyncAt(null);
        setIsSyncing(false);
        setError(null);
        setSyncError(null);
        setRestartMessage(null);

        if (!user) {
            setPreferences(DEFAULT_HEALTH_CONNECT_PREFERENCES);
            setIsLoading(false);
            return;
        }
        const userId = user.id;
        const currentServerUrl = serverUrl;

        async function hydrate() {
            try {
                const [stored, storedLastSuccessfulSync] = await Promise.all([
                    AsyncStorage.getItem(healthConnectPreferencesStorageKey(currentServerUrl, userId)),
                    AsyncStorage.getItem(healthConnectLastSuccessStorageKey(currentServerUrl, userId))
                ]);
                const nextPreferences = parseStoredHealthConnectPreferences(stored);
                if (run !== activeRun.current) return;
                preferencesRef.current = nextPreferences;
                setPreferences(nextPreferences);
                setLastSuccessfulSyncAt(storedLastSuccessfulSync);
                const nextConnection = await getHealthConnectConnection();
                if (run !== activeRun.current) return;
                setConnection(nextConnection);
                setLastRefreshedAt(new Date().toISOString());
                if (nextPreferences.connected && !nextPreferences.paused) {
                    void runForegroundSync(nextConnection);
                }
            } catch (hydrateError) {
                if (run === activeRun.current) {
                    setError(errorMessage(hydrateError, 'Unable to load Health Connect settings.'));
                }
            } finally {
                if (run === activeRun.current) setIsLoading(false);
            }
        }

        void hydrate();
        return () => {
            activeRun.current += 1;
            syncGenerationRef.current += 1;
        };
    }, [runForegroundSync, serverUrl, syncContext, user]);

    useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextState) => {
            if (nextState === 'active' && user) {
                void (async () => {
                    const nextConnection = await refreshConnection();
                    if (nextConnection) await runForegroundSync(nextConnection);
                })();
            }
        });
        return () => subscription.remove();
    }, [refreshConnection, runForegroundSync, user]);

    const connect = useCallback(async () => {
        if (!user) return;
        syncGenerationRef.current += 1;
        setIsBusy(true);
        setError(null);
        setRestartMessage(null);
        try {
            const nextConnection = await requestHealthConnectFeatures(preferencesRef.current.selection);
            setConnection(nextConnection);
            setLastRefreshedAt(new Date().toISOString());
            await persist({ ...preferencesRef.current, connected: true, paused: false });
            await runForegroundSync(nextConnection);
        } catch (connectError) {
            setError(errorMessage(connectError, 'Unable to connect Health Connect. Review access and try again.'));
        } finally {
            setIsBusy(false);
        }
    }, [persist, runForegroundSync, user]);

    const setFeatureEnabled = useCallback(async (feature: HealthConnectFeature, enabled: boolean) => {
        syncGenerationRef.current += 1;
        const nextSelection = { ...preferencesRef.current.selection, [feature]: enabled };
        const nextPreferences = { ...preferencesRef.current, selection: nextSelection };
        setError(null);
        try {
            await persist(nextPreferences);
            if (enabled && nextPreferences.connected) {
                setIsBusy(true);
                const nextConnection = await requestHealthConnectFeatures(nextSelection);
                setConnection(nextConnection);
                setLastRefreshedAt(new Date().toISOString());
                await runForegroundSync(nextConnection);
            }
        } catch (selectionError) {
            setError(errorMessage(selectionError, 'Unable to update Health Connect access.'));
        } finally {
            setIsBusy(false);
        }
    }, [persist, runForegroundSync]);

    const setPaused = useCallback(async (paused: boolean) => {
        if (paused) syncGenerationRef.current += 1;
        setError(null);
        try {
            await persist({ ...preferencesRef.current, paused });
            if (!paused) await runForegroundSync();
        } catch (pauseError) {
            setError(errorMessage(pauseError, 'Unable to update the Health Connect pause setting.'));
        }
    }, [persist, runForegroundSync]);

    const manageAccess = useCallback(async () => {
        setError(null);
        try {
            await openHealthConnectAccess();
        } catch (manageError) {
            setError(errorMessage(manageError, 'Unable to open Health Connect settings.'));
        }
    }, []);

    const updateProvider = useCallback(async () => {
        setError(null);
        try {
            await Linking.openURL(HEALTH_CONNECT_PLAY_STORE_URL);
        } catch (updateError) {
            setError(errorMessage(updateError, 'Unable to open the Health Connect store page.'));
        }
    }, []);

    const disconnect = useCallback(async () => {
        if (!user) return;
        syncGenerationRef.current += 1;
        setIsBusy(true);
        setError(null);
        setRestartMessage(null);
        try {
            await syncPromiseRef.current?.promise;
            const response = await disconnectHealthConnect();
            await clearHealthConnectSyncStorage(serverUrl, user.id);
            await AsyncStorage.removeItem(healthConnectLastSuccessStorageKey(serverUrl, user.id));
            await persist({ ...preferencesRef.current, connected: false, paused: false });
            setConnection((current) => current ? { ...current, grantedFeatures: [] } : current);
            setSyncError(null);
            setIsSyncing(false);
            setLastSuccessfulSyncAt(null);
            const requiresRestart = typeof response === 'object' && response?.requiresRestart;
            setRestartMessage(
                requiresRestart
                    ? 'Access was revoked. Restart Calibrate to finish disconnecting on this Android version.'
                    : 'Access was revoked. If Android still shows Calibrate as connected, restart the app.'
            );
            setLastRefreshedAt(new Date().toISOString());
        } catch (disconnectError) {
            setError(errorMessage(disconnectError, 'Unable to revoke Health Connect access.'));
        } finally {
            setIsBusy(false);
        }
    }, [persist, serverUrl, user]);

    const clearAccountData = useCallback(async () => {
        if (!authenticatedUser) return;
        syncGenerationRef.current += 1;
        await Promise.allSettled(syncPromiseRef.current ? [syncPromiseRef.current.promise] : []);
        try {
            await clearHealthConnectAccountData(serverUrl, authenticatedUser.id);
        } finally {
            preferencesRef.current = DEFAULT_HEALTH_CONNECT_PREFERENCES;
            setPreferences(DEFAULT_HEALTH_CONNECT_PREFERENCES);
            setConnection((current) => current ? { ...current, grantedFeatures: [] } : current);
            setSyncError(null);
            setIsSyncing(false);
            setLastSuccessfulSyncAt(null);
        }
    }, [authenticatedUser, serverUrl]);

    const value = useMemo<HealthConnectContextValue>(() => ({
        ...preferences,
        connection,
        isLoading,
        isBusy,
        isSyncing,
        lastRefreshedAt,
        lastSuccessfulSyncAt,
        error,
        syncError,
        restartMessage,
        connect,
        refresh,
        sync: runForegroundSync,
        setFeatureEnabled,
        setPaused,
        manageAccess,
        updateProvider,
        disconnect,
        clearAccountData
    }), [clearAccountData, connect, connection, disconnect, error, isBusy, isLoading, isSyncing, lastRefreshedAt, lastSuccessfulSyncAt, manageAccess, preferences, refresh, restartMessage, runForegroundSync, setFeatureEnabled, setPaused, syncError, updateProvider]);

    return <HealthConnectContext.Provider value={value}>{children}</HealthConnectContext.Provider>;
}

/** Reads native Health Connect state and throws outside its provider. */
export function useHealthConnect(): HealthConnectContextValue {
    const context = useContext(HealthConnectContext);
    if (!context) throw new Error('useHealthConnect must be used within HealthConnectProvider.');
    return context;
}
