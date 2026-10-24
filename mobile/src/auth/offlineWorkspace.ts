/** @file Account/server-scoped offline identity snapshots for local continuity without granting server authorization. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { dehydrate, hydrate, type DehydratedState, type QueryClient } from '@tanstack/react-query';
import type { UserClientPayload } from '@calibrate/api-client';

const PREFIX = '@calibrate/offline-workspace/v1/';
const TRACKING_KEYS = new Set([
    'mobile-profile', 'mobile-goal', 'mobile-food', 'mobile-food-day', 'mobile-food-days',
    'mobile-metrics', 'mobile-metrics-trend', 'mobile-my-foods', 'mobile-my-foods-library',
    'mobile-recent-foods', 'mobile-food-search', 'mobile-calibration-status'
]);
const pending = new Map<string, Promise<unknown>>();
type Snapshot = { version: 1; origin: string; user: UserClientPayload; cache: DehydratedState };
const origin = (server: string) => new URL(server).origin;
const key = (server: string) => PREFIX + encodeURIComponent(origin(server));

function serialize<T>(server: string, work: () => Promise<T>): Promise<T> {
    const storageKey = key(server);
    const result = (pending.get(storageKey) ?? Promise.resolve()).then(work);
    pending.set(storageKey, result.catch(() => undefined));
    return result;
}

/** Local workspace only. Neither this snapshot nor its user ID authorizes a server request. */
export function saveOfflineWorkspace(server: string, user: UserClientPayload, client: QueryClient): Promise<void> {
    const snapshot: Snapshot = {
        version: 1, origin: origin(server), user,
        cache: dehydrate(client, {
            shouldDehydrateMutation: () => false,
            shouldDehydrateQuery: (query) => TRACKING_KEYS.has(String(query.queryKey[0])) && query.state.data !== undefined
        })
    };
    // Capture before queuing so an account switch cannot serialize the replacement user's cache.
    const encoded = JSON.stringify(snapshot);
    return serialize(server, async () => {
        const next = JSON.parse(encoded) as Snapshot;
        try {
            const previous = JSON.parse(await AsyncStorage.getItem(key(server)) ?? 'null') as Snapshot | null;
            if (previous?.version === 1 && previous.origin === next.origin && previous.user.id === next.user.id && Array.isArray(previous.cache?.queries)) {
                const queries = new Map(previous.cache.queries.filter(query => Array.isArray(query.queryKey) && TRACKING_KEYS.has(String(query.queryKey[0]))).map(query => [query.queryHash, query]));
                for (const query of next.cache.queries) {
                    const prior = queries.get(query.queryHash);
                    if (!prior || query.state.dataUpdatedAt >= prior.state.dataUpdatedAt) queries.set(query.queryHash, query);
                }
                next.cache.queries = [...queries.values()];
            }
        } catch { /* Invalid prior data cannot replace the verified account snapshot. */ }
        await AsyncStorage.setItem(key(server), JSON.stringify(next));
    });
}

/** Serializes removal of the cached offline workspace for the specified server origin. */
export function clearOfflineWorkspace(server: string): Promise<void> {
    return serialize(server, () => AsyncStorage.removeItem(key(server)));
}

/** Restores a valid origin-bound account snapshot into React Query, returning null for unusable snapshots. */
export function restoreOfflineWorkspace(server: string, client: QueryClient): Promise<UserClientPayload | null> {
    return serialize(server, async () => {
        const encoded = await AsyncStorage.getItem(key(server));
        if (!encoded) return null;
        try {
            const snapshot = JSON.parse(encoded) as Snapshot;
            if (snapshot.version !== 1 || snapshot.origin !== origin(server) ||
                !Number.isSafeInteger(snapshot.user?.id) || snapshot.user.id <= 0 ||
                typeof snapshot.user.email !== 'string' || !Array.isArray(snapshot.cache?.queries)) return null;
            client.clear();
            hydrate(client, { mutations: [], queries: snapshot.cache.queries.filter((query) =>
                Array.isArray(query.queryKey) && TRACKING_KEYS.has(String(query.queryKey[0]))) });
            return snapshot.user;
        } catch { return null; }
    });
}

/** Hydrate only the freshly verified account, and only while its async auth generation is still current. */
export function hydrateVerifiedOfflineWorkspace(server: string, userId: number, client: QueryClient, isCurrent: () => boolean): Promise<void> {
    return serialize(server, async () => {
        try {
            const snapshot = JSON.parse(await AsyncStorage.getItem(key(server)) ?? 'null') as Snapshot | null;
            if (!isCurrent() || snapshot?.version !== 1 || snapshot.origin !== origin(server) || snapshot.user.id !== userId || !Array.isArray(snapshot.cache?.queries)) return;
            hydrate(client, { mutations: [], queries: snapshot.cache.queries.filter(query => Array.isArray(query.queryKey) && TRACKING_KEYS.has(String(query.queryKey[0]))) });
        } catch { /* Missing or corrupt local data does not block verified authentication. */ }
    });
}
