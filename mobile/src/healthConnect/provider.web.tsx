/** @file Browser Health Connect fallback with explicitly gated local test simulation. */

import React, {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useSyncExternalStore
} from 'react';
import {
    DEFAULT_HEALTH_CONNECT_PREFERENCES,
    type StoredHealthConnectPreferences
} from './preferences';
import {
    DEFAULT_HEALTH_CONNECT_SELECTION,
    type HealthConnectConnection,
    type HealthConnectFeature
} from './types';

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

export const HEALTH_CONNECT_WEB_FIXTURE_EVENT = 'calibrate:health-connect-fixture';
export const HEALTH_CONNECT_WEB_FIXTURE_GLOBAL = '__CALIBRATE_HEALTH_CONNECT_E2E__';

export type HealthConnectWebFixtureState =
    | 'disconnected'
    | 'denied'
    | 'syncing'
    | 'stale'
    | 'empty'
    | 'failed_sync'
    | 'paused'
    | 'ready';

export type HealthConnectWebFixture = {
    state: HealthConnectWebFixtureState;
    lastSuccessfulSyncAt?: string | null;
    syncError?: string | null;
    error?: string | null;
};

type HealthConnectWebSnapshot = Omit<
    HealthConnectContextValue,
    | 'connect'
    | 'refresh'
    | 'sync'
    | 'setFeatureEnabled'
    | 'setPaused'
    | 'manageAccess'
    | 'updateProvider'
    | 'disconnect'
    | 'clearAccountData'
>;

type FixtureTarget = {
    location?: { hostname?: string };
    __CALIBRATE_HEALTH_CONNECT_E2E__?: HealthConnectWebFixture;
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
    dispatchEvent?: (event: Event) => boolean;
};

const HealthConnectContext = createContext<HealthConnectContextValue | null>(null);
const WEB_UNAVAILABLE = 'Health Connect is available in the Android app.';
const LOCAL_FIXTURE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const FIXTURE_STATES: readonly HealthConnectWebFixtureState[] = [
    'disconnected',
    'denied',
    'syncing',
    'stale',
    'empty',
    'failed_sync',
    'paused',
    'ready'
];
const DEFAULT_GRANTED_FEATURES = (Object.entries(DEFAULT_HEALTH_CONNECT_SELECTION) as Array<
    [HealthConnectFeature, boolean]
>)
    .filter(([, enabled]) => enabled)
    .map(([feature]) => feature);

const WEB_UNAVAILABLE_SNAPSHOT: HealthConnectWebSnapshot = {
    ...DEFAULT_HEALTH_CONNECT_PREFERENCES,
    connection: { availability: 'not_android', initialized: false, grantedFeatures: [] },
    isLoading: false,
    isBusy: false,
    isSyncing: false,
    lastRefreshedAt: null,
    lastSuccessfulSyncAt: null,
    error: null,
    syncError: null,
    restartMessage: null
};

function fixtureTarget(): FixtureTarget {
    return globalThis as unknown as FixtureTarget;
}

/** Restricts browser Health Connect simulation to explicitly allowed local fixture hosts. */
export function isHealthConnectWebFixtureHost(hostname: string | null | undefined): boolean {
    return LOCAL_FIXTURE_HOSTS.has((hostname ?? '').toLowerCase());
}

function isFixture(value: unknown): value is HealthConnectWebFixture {
    if (!value || typeof value !== 'object') return false;
    return FIXTURE_STATES.includes((value as { state?: HealthConnectWebFixtureState }).state as HealthConnectWebFixtureState);
}

/** Accepts a valid browser fixture only on an allowed local development host. */
export function getHealthConnectWebFixtureForHost(
    hostname: string | null | undefined,
    value: unknown
): HealthConnectWebFixture | null {
    return isHealthConnectWebFixtureHost(hostname) && isFixture(value) ? value : null;
}

function readFixture(): HealthConnectWebFixture | null {
    const target = fixtureTarget();
    return getHealthConnectWebFixtureForHost(
        target.location?.hostname,
        target.__CALIBRATE_HEALTH_CONNECT_E2E__
    );
}

function subscribeToFixture(onStoreChange: () => void): () => void {
    const target = fixtureTarget();
    if (!isHealthConnectWebFixtureHost(target.location?.hostname) || !target.addEventListener) {
        return () => undefined;
    }
    target.addEventListener(HEALTH_CONNECT_WEB_FIXTURE_EVENT, onStoreChange);
    return () => target.removeEventListener?.(HEALTH_CONNECT_WEB_FIXTURE_EVENT, onStoreChange);
}

function writeFixture(next: HealthConnectWebFixture): void {
    const target = fixtureTarget();
    if (!isHealthConnectWebFixtureHost(target.location?.hostname)) return;
    target.__CALIBRATE_HEALTH_CONNECT_E2E__ = next;
    if (target.dispatchEvent && typeof Event !== 'undefined') {
        target.dispatchEvent(new Event(HEALTH_CONNECT_WEB_FIXTURE_EVENT));
    }
}

/** Builds deterministic browser simulation state or the unavailable snapshot when no fixture is allowed. */
export function resolveHealthConnectWebFixture(
    fixture: HealthConnectWebFixture | null,
    now = new Date()
): HealthConnectWebSnapshot {
    if (!fixture) return WEB_UNAVAILABLE_SNAPSHOT;

    const connected = fixture.state !== 'disconnected';
    const grantedFeatures = fixture.state === 'denied' || !connected
        ? []
        : DEFAULT_GRANTED_FEATURES;
    let lastSuccessfulSyncAt = fixture.lastSuccessfulSyncAt ?? null;
    if (fixture.state === 'stale' && fixture.lastSuccessfulSyncAt === undefined) {
        lastSuccessfulSyncAt = '2000-01-01T00:00:00.000Z';
    } else if (fixture.state === 'ready' && fixture.lastSuccessfulSyncAt === undefined) {
        lastSuccessfulSyncAt = now.toISOString();
    }
    const syncError = fixture.state === 'failed_sync'
        ? fixture.syncError ?? 'Health activity could not sync. Try again from Health Connect settings.'
        : fixture.syncError ?? null;

    return {
        connected,
        paused: fixture.state === 'paused',
        selection: DEFAULT_HEALTH_CONNECT_SELECTION,
        connection: { availability: 'available', initialized: true, grantedFeatures },
        isLoading: false,
        isBusy: false,
        isSyncing: fixture.state === 'syncing',
        lastRefreshedAt: null,
        lastSuccessfulSyncAt,
        error: fixture.error ?? null,
        syncError,
        restartMessage: null
    };
}

/** Keep shared settings routes renderable without loading Android APIs on web. */
export function HealthConnectProvider({ children }: { children: React.ReactNode }) {
    const fixture = useSyncExternalStore(subscribeToFixture, readFixture, () => null);
    const snapshot = useMemo(() => resolveHealthConnectWebFixture(fixture), [fixture]);

    const setFixtureState = useCallback((state: HealthConnectWebFixtureState): boolean => {
        if (!fixture) return false;
        writeFixture({ ...fixture, state });
        return true;
    }, [fixture]);
    const requireFixture = useCallback(() => {
        if (!fixture) throw new Error(WEB_UNAVAILABLE);
    }, [fixture]);

    const value = useMemo<HealthConnectContextValue>(() => ({
        ...snapshot,
        connect: async () => {
            if (!setFixtureState('empty')) throw new Error(WEB_UNAVAILABLE);
        },
        refresh: async () => undefined,
        sync: async () => {
            if (!setFixtureState('syncing')) throw new Error(WEB_UNAVAILABLE);
        },
        setFeatureEnabled: async () => requireFixture(),
        setPaused: async (paused) => {
            if (!setFixtureState(paused ? 'paused' : 'empty')) throw new Error(WEB_UNAVAILABLE);
        },
        manageAccess: async () => requireFixture(),
        updateProvider: async () => requireFixture(),
        disconnect: async () => {
            setFixtureState('disconnected');
        },
        clearAccountData: async () => {
            setFixtureState('disconnected');
        }
    }), [requireFixture, setFixtureState, snapshot]);

    return <HealthConnectContext.Provider value={value}>{children}</HealthConnectContext.Provider>;
}

/** Reads browser Health Connect presentation state and throws outside its provider. */
export function useHealthConnect(): HealthConnectContextValue {
    const context = useContext(HealthConnectContext);
    if (!context) throw new Error('useHealthConnect must be used within HealthConnectProvider.');
    return context;
}
