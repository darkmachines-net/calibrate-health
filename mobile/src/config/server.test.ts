/** @file Regression coverage for server: server URL parsing. */

import {
    HOSTED_SERVER_URL,
    getConfiguredServerUrl,
    normalizeServerUrl,
    parseServerUrl,
    resolveBrowserServerUrl,
    resolveDefaultNativeServerUrl,
    resolveDefaultWebServerUrl,
    resolveInitialServerUrl,
    testCalibrateServerConnection
} from './server';

const compatibleConfig = {
    api_version: 1,
    api_versions: {
        current: 'v1',
        supported: ['v1'],
        legacy_alias: '/api',
        legacy_deprecation: 'none'
    },
    server_version: '1.2.3',
    hosted_origin: 'https://calibrate.example',
    min_supported_mobile_version: '0.1.0',
    min_supported_wear_version: '0.1.0',
    capabilities: {
        self_hosted_server_url: true,
        native_push: true,
        health_connect_activity: true,
        wear_os_ready: false
    }
};

describe('server URL parsing', () => {
    it('uses the canonical hosted origin while keeping self-hosting available', () => {
        expect(HOSTED_SERVER_URL).toBe('https://calibratehealth.app');
    });

    it('normalizes hosted origins and defaults scheme-less remote hosts to HTTPS', () => {
        expect(normalizeServerUrl('https://calibratehealth.app/settings')).toBe('https://calibratehealth.app');
        expect(normalizeServerUrl('self-hosted.example:3443/api')).toBe('https://self-hosted.example:3443');
    });

    it('supports Android emulator, localhost, and private LAN HTTP development servers', () => {
        expect(normalizeServerUrl('10.0.2.2:3000')).toBe('http://10.0.2.2:3000');
        expect(normalizeServerUrl('localhost:3000/api')).toBe('http://localhost:3000');
        expect(normalizeServerUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
        expect(normalizeServerUrl('http://192.168.0.160:3000/api')).toBe('http://192.168.0.160:3000');
    });

    it('requires HTTPS for private hosts in release policy', () => {
        const releasePolicy = { allowInsecureLocalHttp: false };
        expect(normalizeServerUrl('http://10.0.2.2:3000', releasePolicy)).toBeNull();
        expect(normalizeServerUrl('http://192.168.0.160:3000', releasePolicy)).toBeNull();
        expect(normalizeServerUrl('192.168.0.160:3443', releasePolicy)).toBe('https://192.168.0.160:3443');
    });

    it('rejects unsafe remote HTTP, credentials, unsupported protocols, and empty input', () => {
        expect(parseServerUrl('http://public.example')).toEqual(expect.objectContaining({ ok: false }));
        expect(parseServerUrl('https://user:secret@calibrate.example')).toEqual(expect.objectContaining({ ok: false }));
        expect(normalizeServerUrl('file:///tmp/calibrate')).toBeNull();
        expect(normalizeServerUrl('')).toBeNull();
    });

    it('reads an optional Expo public server override', () => {
        expect(getConfiguredServerUrl('http://192.168.0.160:3000/api')).toBe('http://192.168.0.160:3000');
        expect(getConfiguredServerUrl('not a url')).toBeNull();
    });

    it('uses an explicit development target instead of a stale stored server', () => {
        expect(resolveInitialServerUrl(
            'https://previous.example',
            'http://10.0.2.2:3329',
            'https://calibratehealth.app',
            true
        )).toBe('http://10.0.2.2:3329');
        expect(resolveInitialServerUrl(
            'https://previous.example',
            'https://build-default.example',
            'https://calibratehealth.app',
            false
        )).toBe('https://previous.example');
        expect(resolveInitialServerUrl(
            null,
            'https://build-default.example',
            HOSTED_SERVER_URL,
            false
        )).toBe(HOSTED_SERVER_URL);
    });

    it('targets port 3000 from a loopback Expo dev server but preserves production origins', () => {
        const expoLocation = new URL('http://localhost:8081/login');
        expect(resolveDefaultWebServerUrl(expoLocation, true)).toBe('http://localhost:3000');
        expect(resolveDefaultWebServerUrl(expoLocation, false)).toBe('http://localhost:8081');
        expect(resolveDefaultWebServerUrl(new URL('https://self-hosted.example/app'), true))
            .toBe('https://self-hosted.example');
    });

    it('binds production web auth to the serving origin while allowing an explicit development backend', () => {
        const location = new URL('https://self-hosted.example/login');
        expect(resolveBrowserServerUrl(location, 'https://other.example', false))
            .toBe('https://self-hosted.example');
        expect(resolveBrowserServerUrl(
            new URL('http://localhost:41508/login'),
            'http://localhost:21508',
            true
        )).toBe('http://localhost:21508');
    });

    it('uses the correct loopback address for each native simulator', () => {
        expect(resolveDefaultNativeServerUrl('android', null, true)).toBe('http://10.0.2.2:3000');
        expect(resolveDefaultNativeServerUrl('ios', null, true)).toBe('http://127.0.0.1:3000');
        expect(resolveDefaultNativeServerUrl('ios', 'http://192.168.0.10:3000', true))
            .toBe('http://192.168.0.10:3000');
        expect(resolveDefaultNativeServerUrl('ios', null, false)).toBe(HOSTED_SERVER_URL);
    });
});

describe('testCalibrateServerConnection', () => {
    it('tests the versioned client-config endpoint and accepts a compatible server', async () => {
        const fetchImpl = jest.fn(async () => new Response(JSON.stringify(compatibleConfig), { status: 200 }));

        const result = await testCalibrateServerConnection('https://calibrate.example', {
            fetchImpl: fetchImpl as typeof fetch,
            mobileVersion: '0.2.0',
            clientServerVersion: '1.2.99'
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            url: 'https://calibrate.example',
            message: 'Connected to Calibrate 1.2.3 (API v1).'
        }));
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://calibrate.example/api/v1/client-config',
            expect.objectContaining({ method: 'GET', cache: 'no-store' })
        );
    });

    it('keeps the global receiver when using the browser fetch implementation', async () => {
        const originalFetch = globalThis.fetch;
        const receiverAwareFetch = jest.fn(function (this: typeof globalThis) {
            if (this !== globalThis) throw new TypeError('Illegal invocation');
            return Promise.resolve(new Response(JSON.stringify(compatibleConfig), { status: 200 }));
        });
        globalThis.fetch = receiverAwareFetch as typeof fetch;

        try {
            const result = await testCalibrateServerConnection('https://calibrate.example');
            expect(result).toEqual(expect.objectContaining({ ok: true }));
            expect(receiverAwareFetch).toHaveBeenCalledTimes(1);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('reports unreachable and non-Calibrate servers clearly', async () => {
        const unreachable = await testCalibrateServerConnection('https://offline.example', {
            fetchImpl: jest.fn(async () => { throw new TypeError('Network request failed'); }) as typeof fetch
        });
        expect(unreachable).toEqual(expect.objectContaining({ ok: false, code: 'unreachable' }));

        const wrongServer = await testCalibrateServerConnection('https://files.example', {
            fetchImpl: jest.fn(async () => new Response('<html />', { status: 200 })) as typeof fetch
        });
        expect(wrongServer).toEqual(expect.objectContaining({ ok: false, code: 'not_calibrate' }));
    });

    it('rejects unsupported APIs and mobile versions without switching', async () => {
        const oldApi = {
            ...compatibleConfig,
            api_versions: { ...compatibleConfig.api_versions, supported: ['v2'] }
        };
        const unsupported = await testCalibrateServerConnection('https://future.example', {
            fetchImpl: jest.fn(async () => new Response(JSON.stringify(oldApi), { status: 200 })) as typeof fetch
        });
        expect(unsupported).toEqual(expect.objectContaining({ ok: false, code: 'incompatible' }));

        const upgradeRequired = await testCalibrateServerConnection('https://newer.example', {
            fetchImpl: jest.fn(async () => new Response(JSON.stringify({
                ...compatibleConfig,
                min_supported_mobile_version: '2.0.0'
            }), { status: 200 })) as typeof fetch,
            mobileVersion: '1.9.9'
        });
        expect(upgradeRequired).toEqual(expect.objectContaining({
            ok: false,
            code: 'incompatible',
            message: 'This server requires Calibrate 2.0.0 or newer.'
        }));

        const malformedLocalVersion = await testCalibrateServerConnection('https://newer.example', {
            fetchImpl: jest.fn(async () => new Response(JSON.stringify(compatibleConfig), { status: 200 })) as typeof fetch,
            mobileVersion: 'development'
        });
        expect(malformedLocalVersion).toEqual(expect.objectContaining({ ok: false, code: 'incompatible' }));
    });

    it('allows older client minors and patch drift but blocks newer client minors and major mismatches', async () => {
        const fetchImpl = jest.fn(async () => new Response(JSON.stringify(compatibleConfig), { status: 200 }));
        await expect(testCalibrateServerConnection('https://calibrate.example', {
            fetchImpl: fetchImpl as typeof fetch,
            clientServerVersion: '1.1.99'
        })).resolves.toEqual(expect.objectContaining({ ok: true }));
        await expect(testCalibrateServerConnection('https://calibrate.example', {
            fetchImpl: fetchImpl as typeof fetch,
            clientServerVersion: '1.2.99'
        })).resolves.toEqual(expect.objectContaining({ ok: true }));

        const serverBehindMinor = await testCalibrateServerConnection('https://calibrate.example', {
            fetchImpl: fetchImpl as typeof fetch,
            clientServerVersion: '1.3.0'
        });
        expect(serverBehindMinor).toEqual(expect.objectContaining({
            ok: false,
            code: 'incompatible',
            message: 'This Calibrate update requires server 1.3.x or a newer 1.x release, but this server is 1.2.3. Update the server first.',
            mismatch: expect.objectContaining({ status: 'server_behind' })
        }));

        const serverBehindMajor = await testCalibrateServerConnection('https://calibrate.example', {
            fetchImpl: fetchImpl as typeof fetch,
            clientServerVersion: '2.0.0'
        });
        expect(serverBehindMajor).toEqual(expect.objectContaining({
            ok: false,
            code: 'incompatible',
            message: 'This Calibrate update requires server major version 2.x, but this server is 1.2.3. Update the server first.',
            mismatch: expect.objectContaining({ status: 'server_behind' })
        }));

        const clientBehind = await testCalibrateServerConnection('https://calibrate.example', {
            fetchImpl: fetchImpl as typeof fetch,
            clientServerVersion: '0.99.9'
        });
        expect(clientBehind).toEqual(expect.objectContaining({
            ok: false,
            code: 'incompatible',
            message: 'This server requires a Calibrate client for major version 1.x, but this client targets 0.x. Update Calibrate first.',
            mismatch: expect.objectContaining({ status: 'client_behind' })
        }));
    });
});
