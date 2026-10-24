/** @file Regression coverage for cache Isolation web: browser PWA cache isolation. */

import {
    PWA_CACHE_MESSAGES,
    clearBrowserUserScopedCaches
} from './cacheIsolation.web';

describe('browser PWA cache isolation', () => {
    it('clears user-scoped caches only and sends no account or server identifiers', async () => {
        const deleted: string[] = [];
        const postMessage = jest.fn();
        const cleared = await clearBrowserUserScopedCaches({
            cacheStorage: {
                keys: async () => [
                    'calibrate-expo-web-shell-v2',
                    'calibrate-expo-web-user-old-account',
                    'unrelated-cache'
                ],
                delete: async (key) => {
                    deleted.push(key);
                    return true;
                }
            },
            serviceWorker: { controller: { postMessage } as unknown as ServiceWorker }
        });

        expect(cleared).toBe(1);
        expect(deleted).toEqual(['calibrate-expo-web-user-old-account']);
        expect(postMessage).toHaveBeenCalledWith({ type: PWA_CACHE_MESSAGES.CLEAR_USER_SCOPED });
        expect(JSON.stringify(postMessage.mock.calls)).not.toMatch(/userId|serverUrl|token/i);
    });
});
