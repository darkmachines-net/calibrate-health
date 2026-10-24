/** @file Regression coverage for service Worker Contract: Expo web service worker contract. */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

describe('Expo web service worker contract', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'public', 'sw.js'), 'utf8');

    it('bypasses backend API and authentication requests before adding a fetch handler response', () => {
        expect(source).toMatch(/\^\\\/\(\?:api\|auth\)/);
        expect(source).toMatch(/url\.origin !== self\.location\.origin \|\| isBackendPath\(url\.pathname\)/);
        expect(source.indexOf('isBackendPath(url.pathname)')).toBeLessThan(source.indexOf('event.respondWith'));
    });

    it('activates an update only after an explicit skip-waiting message', () => {
        const installHandler = source.slice(
            source.indexOf("self.addEventListener('install'"),
            source.indexOf("self.addEventListener('activate'")
        );
        expect(source).toMatch(/event\.data\?\.type === 'SKIP_WAITING'/);
        expect(installHandler).not.toMatch(/skipWaiting\(\)/);
    });

    it('handles push delivery, clicks, and browser endpoint rotation', () => {
        expect(source).toMatch(/self\.addEventListener\('push'/);
        expect(source).toMatch(/self\.addEventListener\('notificationclick'/);
        expect(source).toMatch(/self\.addEventListener\('pushsubscriptionchange'/);
        expect(source).toMatch(/CALIBRATE_PUSH_SUBSCRIPTION_CHANGED/);
    });

    it('never opens an external notification URL', async () => {
        const handlers = new Map<string, (event: any) => void>();
        const opened: string[] = [];
        const self = {
            location: { origin: 'https://calibrate.example' },
            addEventListener: (type: string, handler: (event: any) => void) => handlers.set(type, handler),
            clients: {
                claim: async () => undefined,
                matchAll: async () => [],
                openWindow: async (url: string) => { opened.push(url); }
            },
            registration: {
                showNotification: async () => undefined,
                pushManager: { subscribe: async () => undefined }
            },
            skipWaiting: async () => undefined
        };
        vm.runInNewContext(source, {
            self,
            URL,
            Promise,
            Response,
            caches: {
                open: async () => ({ addAll: async () => undefined, match: async () => undefined, put: async () => undefined }),
                keys: async () => [],
                delete: async () => true,
                match: async () => undefined
            },
            fetch: async () => new Response(),
            console
        });

        let completion: Promise<void> | undefined;
        handlers.get('notificationclick')?.({
            action: '',
            notification: { close: () => undefined, data: { url: 'https://evil.example/steal' } },
            waitUntil: (promise: Promise<void>) => { completion = promise; }
        });
        await completion;
        expect(opened).toEqual(['https://calibrate.example/']);
    });
});
