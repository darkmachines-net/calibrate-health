/** @file Account-scoped browser cache cleanup and worker notification without leaking identity. */

export const PWA_CACHE_NAMES = {
    USER_PREFIX: 'calibrate-expo-web-user-'
} as const;

export const PWA_CACHE_MESSAGES = {
    CLEAR_USER_SCOPED: 'CALIBRATE_CLEAR_USER_SCOPED_CACHES'
} as const;

type CacheStorageCleanup = Pick<CacheStorage, 'keys' | 'delete'>;
type ServiceWorkerMessenger = Pick<ServiceWorkerContainer, 'controller'>;

export type BrowserCacheIsolationEnvironment = {
    cacheStorage: CacheStorageCleanup | null;
    serviceWorker: ServiceWorkerMessenger | null;
};

function browserCacheIsolationEnvironment(): BrowserCacheIsolationEnvironment {
    return {
        cacheStorage: typeof caches === 'undefined' ? null : caches,
        serviceWorker: typeof navigator === 'undefined' || !('serviceWorker' in navigator)
            ? null
            : navigator.serviceWorker
    };
}

/** Clear only account-scoped browser caches and notify the active worker without sending identity data. */
export async function clearBrowserUserScopedCaches(
    environment: BrowserCacheIsolationEnvironment = browserCacheIsolationEnvironment()
): Promise<number> {
    const cacheKeys = await environment.cacheStorage?.keys() ?? [];
    const matchingKeys = cacheKeys.filter((key) => key.startsWith(PWA_CACHE_NAMES.USER_PREFIX));
    await Promise.all(matchingKeys.map((key) => environment.cacheStorage?.delete(key)));
    environment.serviceWorker?.controller?.postMessage({ type: PWA_CACHE_MESSAGES.CLEAR_USER_SCOPED });
    return matchingKeys.length;
}
