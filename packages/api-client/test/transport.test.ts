/** @file Regression coverage for transport: default browser transport preserves the global fetch receiver. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, CalibrateApiClient, parseApiError } from '../src/client.ts';
import type { ClientUpgradeRequirement } from '@calibrate/shared/clientCompatibility';

type InternalRequest = <T>(
    path: string,
    options?: RequestInit & { auth?: boolean; json?: unknown }
) => Promise<T>;

const getInternalRequest = (client: CalibrateApiClient): InternalRequest =>
    (client as unknown as { request: InternalRequest }).request.bind(client);

const abortError = (): Error => {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
};

function requireCaptured<T>(value: T | null, label: string): T {
    assert.ok(value, `${label} was not captured`);
    return value;
}

const createAbortAwareFetch = (): typeof fetch =>
    (async (_input, init) => {
        const signal = init?.signal;
        if (signal?.aborted) throw abortError();

        return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        });
    }) as typeof fetch;

test('default browser transport preserves the global fetch receiver', async (t) => {
    const originalFetch = globalThis.fetch;
    let observedReceiver: unknown = null;
    globalThis.fetch = (async function (this: typeof globalThis) {
        observedReceiver = this;
        return new Response('{"api_version":1}', { status: 200 });
    }) as typeof fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const client = new CalibrateApiClient({ baseUrl: 'https://calibrate.example' });
    await client.getClientConfig();

    assert.equal(observedReceiver, globalThis);
});

test('client configuration forwards an explicit cache policy', async () => {
    let capturedInit: RequestInit | undefined;
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (_input, init) => {
            capturedInit = init;
            return new Response('{"api_version":1}', { status: 200 });
        }) as typeof fetch
    });

    await client.getClientConfig({ cache: 'no-store' });

    assert.equal(capturedInit?.cache, 'no-store');
});

test('request timeout reports a connection timeout rather than a caller abort', async () => {
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: createAbortAwareFetch(),
        requestTimeoutMs: 5
    });

    await assert.rejects(
        () => client.getClientConfig(),
        (error) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /^Request timed out while connecting to https:\/\/calibrate\.example\./);
            assert.notEqual(error.name, 'AbortError');
            return true;
        }
    );
});

test('request timeout settles even when the fetch implementation ignores abort', async () => {
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (() => new Promise<Response>(() => undefined)) as typeof fetch,
        requestTimeoutMs: 5
    });

    await assert.rejects(
        () => client.getClientConfig(),
        /Request timed out while connecting to https:\/\/calibrate\.example\./
    );
});

test('caller abort remains an AbortError and is not rewritten as a timeout', async () => {
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: createAbortAwareFetch(),
        requestTimeoutMs: 1_000
    });
    const controller = new AbortController();
    const pending = getInternalRequest(client)('/api/client-config', {
        auth: false,
        signal: controller.signal
    });

    controller.abort();

    await assert.rejects(
        () => pending,
        (error) => {
            assert.ok(error instanceof Error);
            assert.equal(error.name, 'AbortError');
            assert.doesNotMatch(error.message, /timed out/i);
            return true;
        }
    );
});

test('a signal aborted before the request reaches fetch is still honored', async () => {
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: createAbortAwareFetch(),
        requestTimeoutMs: 1_000
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        () => getInternalRequest(client)('/api/client-config', { auth: false, signal: controller.signal }),
        (error) => {
            assert.ok(error instanceof Error);
            assert.equal(error.name, 'AbortError');
            return true;
        }
    );
});

for (const responseBody of ['upstream unavailable', '<html><body>Bad gateway</body></html>', '{"message":']) {
    test(`non-JSON error body is retained without masking HTTP status: ${responseBody.slice(0, 20)}`, async () => {
        const client = new CalibrateApiClient({
            baseUrl: 'https://calibrate.example',
            fetchImpl: (async () => new Response(responseBody, { status: 502 })) as typeof fetch
        });

        await assert.rejects(
            () => client.getClientConfig(),
            (error) => {
                assert.ok(error instanceof ApiError);
                assert.equal(error.status, 502);
                assert.equal(error.message, 'Request failed with status 502');
                assert.equal(error.body, responseBody);
                return true;
            }
        );
    });
}

test('standard API errors expose typed metadata and prefer the response request ID', async () => {
    const body = {
        message: 'The request could not be validated.',
        code: 'VALIDATION_FAILED',
        field_errors: {
            email: ['Enter a valid email address.'],
            ignored: [null, 42]
        },
        retryable: false,
        request_id: 'body-request-id'
    };
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async () => new Response(JSON.stringify(body), {
            status: 422,
            headers: { 'x-request-id': 'header-request-id' }
        })) as typeof fetch
    });

    await assert.rejects(
        () => client.getClientConfig(),
        (error) => {
            assert.ok(error instanceof ApiError);
            assert.equal(error.message, body.message);
            assert.equal(error.code, 'VALIDATION_FAILED');
            assert.deepEqual(error.fieldErrors, { email: ['Enter a valid email address.'] });
            assert.equal(error.retryable, false);
            assert.equal(error.requestId, 'header-request-id');
            assert.deepEqual(error.body, body);
            return true;
        }
    );
});

test('legacy message-only API errors remain compatible without invented metadata', async () => {
    const body = { message: 'Not found' };
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async () => new Response(JSON.stringify(body), { status: 404 })) as typeof fetch
    });

    await assert.rejects(
        () => client.getClientConfig(),
        (error) => {
            assert.ok(error instanceof ApiError);
            assert.equal(error.message, body.message);
            assert.equal(error.code, null);
            assert.equal(error.fieldErrors, undefined);
            assert.equal(error.retryable, undefined);
            assert.equal(error.requestId, null);
            return true;
        }
    );
});

test('malformed API error metadata is ignored instead of entering typed client state', async () => {
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async () => new Response(JSON.stringify({
            message: 'Request rejected',
            code: { provider: 'secret' },
            field_errors: { email: 'postgres failure', password: [false, null] },
            retryable: 'yes',
            request_id: 'x'.repeat(1_000)
        }), { status: 400 })) as typeof fetch
    });

    await assert.rejects(
        () => client.getClientConfig(),
        (error) => {
            assert.ok(error instanceof ApiError);
            assert.equal(error.code, null);
            assert.equal(error.fieldErrors, undefined);
            assert.equal(error.retryable, undefined);
            assert.equal(error.requestId, null);
            return true;
        }
    );
});

test('API error metadata bounds field fanout and rejects display-hostile tokens', () => {
    const fieldErrors = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
        `field_${index}`,
        Array.from({ length: 12 }, (__, messageIndex) => `message ${messageIndex}`)
    ]));
    const parsed = parseApiError({
        code: 'SERVER_ERROR\nprivate detail',
        field_errors: fieldErrors,
        retryable: true,
        request_id: 'request-id\nspoofed label'
    });

    assert.equal(parsed.code, null);
    assert.equal(parsed.requestId, null);
    assert.equal(Object.keys(parsed.fieldErrors ?? {}).length, 32);
    assert.equal(parsed.fieldErrors?.field_0?.length, 8);
});

test('one successful refresh retries the original request with the replacement token', async () => {
    const authorizationHeaders: Array<string | null> = [];
    let accessToken = 'expired-token';
    let refreshCalls = 0;
    let unauthorizedCalls = 0;
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        getAccessToken: () => accessToken,
        refreshAccessToken: async () => {
            refreshCalls += 1;
            accessToken = 'replacement-token';
            return true;
        },
        onUnauthorized: () => {
            unauthorizedCalls += 1;
        },
        fetchImpl: (async (_input, init) => {
            authorizationHeaders.push(new Headers(init?.headers).get('authorization'));
            if (authorizationHeaders.length === 1) {
                return new Response('{"message":"expired"}', { status: 401 });
            }
            return new Response('{"user":{"id":7}}', { status: 200 });
        }) as typeof fetch
    });

    const result = await client.getMe();

    assert.equal(result.user.id, 7);
    assert.deepEqual(authorizationHeaders, ['Bearer expired-token', 'Bearer replacement-token']);
    assert.equal(refreshCalls, 1);
    assert.equal(unauthorizedCalls, 0);
});

test('a late 401 from the previous access token reuses the completed refresh', async () => {
    let accessToken = 'expired-token';
    let refreshCalls = 0;
    let unauthorizedCalls = 0;
    let expiredRequestCount = 0;
    let releaseFirstExpiredRequest: () => void = () => undefined;
    let releaseLateExpiredRequest: () => void = () => undefined;
    const firstExpiredRequestStarted = new Promise<void>((resolve) => {
        releaseFirstExpiredRequest = resolve;
    });
    const lateExpiredRequest = new Promise<void>((resolve) => {
        releaseLateExpiredRequest = resolve;
    });
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        getAccessToken: () => accessToken,
        refreshAccessToken: async () => {
            refreshCalls += 1;
            accessToken = 'replacement-token';
            return true;
        },
        onUnauthorized: () => {
            unauthorizedCalls += 1;
        },
        fetchImpl: (async (_input, init) => {
            const authorization = new Headers(init?.headers).get('authorization');
            if (authorization === 'Bearer expired-token') {
                expiredRequestCount += 1;
                if (expiredRequestCount === 1) {
                    await firstExpiredRequestStarted;
                } else {
                    releaseFirstExpiredRequest();
                    await lateExpiredRequest;
                }
                return new Response('{"message":"expired"}', { status: 401 });
            }
            return new Response('{"user":{"id":7}}', { status: 200 });
        }) as typeof fetch
    });

    const firstRequest = client.getMe();
    const lateRequest = client.getUserProfile();
    await firstRequest;
    releaseLateExpiredRequest();
    await lateRequest;

    assert.equal(expiredRequestCount, 2);
    assert.equal(refreshCalls, 1);
    assert.equal(unauthorizedCalls, 0);
});

test('a retried 401 does not start another refresh loop', async () => {
    let accessToken = 'expired-token';
    let fetchCalls = 0;
    let refreshCalls = 0;
    let unauthorizedCalls = 0;
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        getAccessToken: () => accessToken,
        refreshAccessToken: async () => {
            refreshCalls += 1;
            accessToken = 'replacement-token';
            return true;
        },
        onUnauthorized: () => {
            unauthorizedCalls += 1;
        },
        fetchImpl: (async () => {
            fetchCalls += 1;
            return new Response('{"message":"still unauthorized"}', { status: 401 });
        }) as typeof fetch
    });

    await assert.rejects(
        () => client.getMe(),
        (error) => {
            assert.ok(error instanceof ApiError);
            assert.equal(error.status, 401);
            assert.equal(error.message, 'still unauthorized');
            return true;
        }
    );
    assert.equal(fetchCalls, 2);
    assert.equal(refreshCalls, 1);
    assert.equal(unauthorizedCalls, 1);
});

test('native identity is attached to public and authenticated requests and cannot be overridden', async () => {
    const captured: Headers[] = [];
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        clientIdentity: { platform: 'android_phone', version: '1.2.3' },
        fetchImpl: (async (_input, init) => {
            captured.push(new Headers(init?.headers));
            return new Response('{}', { status: 200 });
        }) as typeof fetch
    });

    await client.getClientConfig();
    await getInternalRequest(client)('/api/user/profile', {
        headers: {
            'x-calibrate-client-platform': 'wear_os',
            'x-calibrate-client-version': '99.0.0'
        }
    });

    assert.equal(captured.length, 2);
    for (const headers of captured) {
        assert.equal(headers.get('x-calibrate-client-platform'), 'android_phone');
        assert.equal(headers.get('x-calibrate-client-version'), '1.2.3');
    }
});

test('legacy food-day responses remain open and editable', async () => {
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async () => new Response(JSON.stringify({
            date: '2026-07-23',
            is_complete: false,
            completed_at: null
        }), { status: 200 })) as typeof fetch
    });

    assert.deepEqual(await client.getFoodDay('2026-07-23'), {
        date: '2026-07-23',
        status: 'OPEN',
        origin: null,
        source: 'STORED',
        is_representative: false,
        is_complete: false,
        completed_at: null,
        updated_at: null
    });
});

test('browser cookie transport uses session endpoints without native or bearer credentials', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        requestCredentials: 'include',
        fetchImpl: (async (input, init = {}) => {
            requests.push({ url: String(input), init });
            return new Response('{"user":{"id":7}}', { status: 200 });
        }) as typeof fetch
    });

    await client.loginBrowser({ email: 'person@example.com', password: 'secret123' });
    await client.registerBrowser({
        email: 'new@example.com',
        password: 'secret456',
        terms_version: '2026-08-09',
        privacy_version: '2026-07-24',
        accept_terms: true,
        accept_privacy: true
    });
    await client.getMe();
    await client.logoutBrowser();

    assert.deepEqual(requests.map(({ url }) => url), [
        'https://calibrate.example/auth/login',
        'https://calibrate.example/auth/register',
        'https://calibrate.example/auth/me',
        'https://calibrate.example/auth/logout'
    ]);
    assert.deepEqual(requests.map(({ init }) => init.method), ['POST', 'POST', undefined, 'POST']);
    for (const { init } of requests) {
        const headers = new Headers(init.headers);
        assert.equal(init.credentials, 'include');
        assert.equal(headers.get('authorization'), null);
        assert.equal(headers.get('x-calibrate-client-platform'), null);
        assert.equal(headers.get('x-calibrate-client-version'), null);
    }
    assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
        email: 'person@example.com',
        password: 'secret123'
    });
    assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), {
        email: 'new@example.com',
        password: 'secret456',
        terms_version: '2026-08-09',
        privacy_version: '2026-07-24',
        accept_terms: true,
        accept_privacy: true
    });
});

test('browser Lose It uploads submit a real Blob instead of a React Native URI descriptor', async () => {
    let uploaded: FormData | null = null;
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (_input, init) => {
            uploaded = init?.body as FormData;
            return new Response('{}', { status: 200 });
        }) as typeof fetch
    });
    const exportBlob = new Blob(['zip export'], { type: 'application/zip' });

    await client.executeLoseItImport(exportBlob);

    const uploadedForm = requireCaptured<FormData>(uploaded, 'upload form');
    const uploadedFile = uploadedForm.get('file');
    assert.ok(uploadedFile instanceof Blob);
    assert.equal(await uploadedFile.text(), 'zip export');
});

test('browser Lose It object URLs are hydrated before upload', async () => {
    const objectUrl = 'blob:https://calibrate.example/loseit-export';
    const exportBlob = new Blob(['zip export'], { type: 'application/zip' });
    let uploaded: FormData | null = null;
    const requestedUrls: string[] = [];
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input, init) => {
            const url = String(input);
            requestedUrls.push(url);
            if (url === objectUrl) {
                return new Response(exportBlob, { status: 200 });
            }
            uploaded = init?.body as FormData;
            return new Response('{}', { status: 200 });
        }) as typeof fetch
    });

    await client.executeLoseItImport({ uri: objectUrl, name: 'loseit-export.zip', type: 'application/zip' });

    assert.deepEqual(requestedUrls, [objectUrl, 'https://calibrate.example/api/v1/imports/loseit/execute']);
    const uploadedForm = requireCaptured<FormData>(uploaded, 'upload form');
    const uploadedFile = uploadedForm.get('file');
    assert.ok(uploadedFile instanceof Blob);
    assert.equal(await uploadedFile.text(), 'zip export');
});

test('native Lose It URIs remain FormData descriptors even when React Native exposes window', async (t) => {
    const requestedUrls: string[] = [];
    const nativeFile = {
        uri: 'content://com.android.providers.downloads.documents/document/loseit-export',
        name: 'loseit-export.zip',
        type: 'application/zip'
    };
    class NativeFormData {
        readonly fields: Array<{ name: string; value: unknown }> = [];

        append(name: string, value: unknown): void {
            this.fields.push({ name, value });
        }
    }
    const originalFormData = globalThis.FormData;
    const globalWithWindow = globalThis as unknown as { window?: object };
    const originalWindow = globalWithWindow.window;
    globalThis.FormData = NativeFormData as unknown as typeof FormData;
    globalWithWindow.window = {};
    t.after(() => {
        globalThis.FormData = originalFormData;
        if (originalWindow === undefined) {
            delete globalWithWindow.window;
        } else {
            globalWithWindow.window = originalWindow;
        }
    });
    let uploaded: NativeFormData | null = null;
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input, init) => {
            requestedUrls.push(String(input));
            uploaded = init?.body as unknown as NativeFormData;
            return new Response('{}', { status: 200 });
        }) as typeof fetch
    });

    await client.executeLoseItImport(nativeFile);

    assert.deepEqual(requestedUrls, ['https://calibrate.example/api/v1/imports/loseit/execute']);
    const uploadedForm = requireCaptured<NativeFormData>(uploaded, 'native upload form');
    assert.deepEqual(uploadedForm.fields, [{ name: 'file', value: nativeFile }]);
});

test('a per-request credential policy overrides the browser client default', async () => {
    let credentials: RequestCredentials | undefined;
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        requestCredentials: 'include',
        fetchImpl: (async (_input, init) => {
            credentials = init?.credentials;
            return new Response('{}', { status: 200 });
        }) as typeof fetch
    });

    await getInternalRequest(client)('/api/client-config', {
        auth: false,
        credentials: 'omit'
    });

    assert.equal(credentials, 'omit');
});

test('browser push methods use the versioned cookie-session endpoints', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        requestCredentials: 'include',
        fetchImpl: (async (input, init) => {
            requests.push({ url: String(input), init: init ?? {} });
            const body = String(input).endsWith('/public-key') ? { publicKey: 'AQID' } : { ok: true };
            return new Response(JSON.stringify(body), { status: 200 });
        }) as typeof fetch
    });
    const subscription = {
        endpoint: 'https://push.example/subscription',
        expirationTime: null,
        keys: { p256dh: 'p256dh', auth: 'auth' }
    };

    assert.deepEqual(await client.getBrowserPushPublicKey(), { publicKey: 'AQID' });
    await client.registerBrowserPushSubscription(subscription);
    await client.unregisterBrowserPushSubscription(subscription.endpoint);

    assert.deepEqual(requests.map(({ url, init }) => ({
        url,
        method: init.method ?? 'GET',
        credentials: init.credentials,
        body: init.body
    })), [
        {
            url: 'https://calibrate.example/api/v1/notifications/public-key',
            method: 'GET',
            credentials: 'include',
            body: undefined
        },
        {
            url: 'https://calibrate.example/api/v1/notifications/subscription',
            method: 'POST',
            credentials: 'include',
            body: JSON.stringify(subscription)
        },
        {
            url: 'https://calibrate.example/api/v1/notifications/subscription',
            method: 'DELETE',
            credentials: 'include',
            body: JSON.stringify({ endpoint: subscription.endpoint })
        }
    ]);
});

test('upgrade-required responses notify the native shell without triggering auth logout', async () => {
    const requirements: ClientUpgradeRequirement[] = [];
    let unauthorizedCalls = 0;
    const body = {
        code: 'CLIENT_UPGRADE_REQUIRED',
        platform: 'android_phone',
        current_version: '0.1.0',
        minimum_supported_version: '0.2.0',
        message: 'Update Calibrate for Android to version 0.2.0 or newer to continue.',
        retryable: false
    };
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        clientIdentity: { platform: 'android_phone', version: '0.1.0' },
        onClientUpgradeRequired: (requirement) => { requirements.push(requirement); },
        onUnauthorized: () => { unauthorizedCalls += 1; },
        fetchImpl: (async () => new Response(JSON.stringify(body), { status: 426 })) as typeof fetch
    });

    await assert.rejects(
        () => client.getUserProfile(),
        (error) => error instanceof ApiError && error.status === 426
    );
    assert.deepEqual(requirements, [body]);
    assert.equal(unauthorizedCalls, 0);
});

test('malformed upgrade bodies cannot inject unbounded compatibility UI content', async () => {
    let notifications = 0;
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        clientIdentity: { platform: 'android_phone', version: '0.1.0' },
        onClientUpgradeRequired: () => { notifications += 1; },
        fetchImpl: (async () => new Response(JSON.stringify({
            code: 'CLIENT_UPGRADE_REQUIRED',
            platform: 'android_phone',
            current_version: '0.1.0',
            minimum_supported_version: 'not-semver',
            message: 'x'.repeat(10_000),
            retryable: false
        }), { status: 426 })) as typeof fetch
    });

    await assert.rejects(() => client.getClientConfig(), ApiError);
    assert.equal(notifications, 0);
});
