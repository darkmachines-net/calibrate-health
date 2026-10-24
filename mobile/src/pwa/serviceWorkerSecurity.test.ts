/** @file Regression coverage for service Worker Security: service worker cache security. */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

type ServiceWorkerHandler = (event: any) => void;

function loadWorker(options: { cacheKeys?: string[]; offline?: boolean; cachedRoutes?: Record<string, string> } = {}) {
    const source = fs.readFileSync(path.join(process.cwd(), 'public', 'sw.js'), 'utf8');
    const handlers = new Map<string, ServiceWorkerHandler>();
    const deleted: string[] = [];
    const self = {
        location: { origin: 'https://calibrate.example' },
        addEventListener: (type: string, handler: ServiceWorkerHandler) => handlers.set(type, handler),
        clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => undefined },
        registration: {
            showNotification: async () => undefined,
            pushManager: { subscribe: async () => undefined }
        },
        skipWaiting: async () => undefined
    };
    const cache = {
        addAll: async () => undefined,
        match: async (key: string) => options.cachedRoutes?.[key] ? new Response(options.cachedRoutes[key]) : undefined,
        put: async () => undefined
    };
    vm.runInNewContext(source, {
        self,
        URL,
        Promise,
        Response,
        caches: {
            open: async () => cache,
            keys: async () => options.cacheKeys ?? [],
            delete: async (key: string) => { deleted.push(key); return true; }
        },
        fetch: async () => { if (options.offline) throw new TypeError('offline'); return new Response('asset'); },
        console
    });
    return { source, handlers, deleted };
}

describe('service worker cache security', () => {
    it('responds only for navigations or explicit/fingerprinted static assets', () => {
        const { handlers } = loadWorker();
        const fetchHandler = handlers.get('fetch');
        expect(fetchHandler).toBeDefined();

        for (const url of [
            'https://calibrate.example/api/v1/user/me',
            'https://calibrate.example/auth/sessions',
            'https://calibrate.example/private-profile.json'
        ]) {
            const respondWith = jest.fn();
            fetchHandler?.({ request: new Request(url), respondWith, waitUntil: jest.fn() });
            expect(respondWith).not.toHaveBeenCalled();
        }

        const respondWith = jest.fn();
        fetchHandler?.({
            request: new Request('https://calibrate.example/_expo/static/js/web/index-760f341ab1c33c72.js'),
            respondWith,
            waitUntil: jest.fn()
        });
        expect(respondWith).toHaveBeenCalledTimes(1);
    });

    it('uses exported static shells for offline navigation without runtime-caching navigation responses', () => {
        const { source } = loadWorker();
        expect(source).toMatch(/const APP_SHELL = \[\s*'\/index\.html'/);
        const navigationBlock = source.slice(
            source.indexOf("if (request.mode === 'navigate')"),
            source.indexOf('if (!isCacheableStaticAsset(url))')
        );
        expect(navigationBlock).toMatch(/cache\.match\('\/index\.html'\)/);
        expect(navigationBlock).not.toMatch(/cache\.put/);
    });

    it('restores the matching exported route offline to preserve hydration', async () => {
        const { handlers } = loadWorker({ offline: true, cachedRoutes: { '/index.html': 'landing', '/today.html': 'today' } });
        for (const pathname of ['/today', '/today/', '/today.html']) {
            let result: Promise<Response> | undefined;
            handlers.get('fetch')?.({ request: { url: 'https://calibrate.example' + pathname, method: 'GET', mode: 'navigate' }, respondWith: (value: Promise<Response>) => { result = value; } });
            expect(await (await result)?.text()).toBe('today');
        }
    });

    it('purges only user-scoped caches through an identity-free message', async () => {
        const { handlers, deleted } = loadWorker({
            cacheKeys: [
                'calibrate-expo-web-shell-v2',
                'calibrate-expo-web-user-account-a',
                'unrelated-cache'
            ]
        });
        const replies: unknown[] = [];
        let completion: Promise<void> | undefined;
        handlers.get('message')?.({
            data: { type: 'CALIBRATE_CLEAR_USER_SCOPED_CACHES' },
            source: { postMessage: (message: unknown) => replies.push(message) },
            waitUntil: (promise: Promise<void>) => { completion = promise; }
        });
        await completion;

        expect(deleted).toEqual(['calibrate-expo-web-user-account-a']);
        expect(replies).toEqual([{ type: 'CALIBRATE_USER_SCOPED_CACHES_CLEARED' }]);
        expect(JSON.stringify(replies)).not.toMatch(/account|server|token/i);
    });
});
