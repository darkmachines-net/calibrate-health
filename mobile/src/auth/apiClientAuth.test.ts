/** @file Regression coverage for api Client Auth: CalibrateApiClient mobile authentication recovery. */

import { ApiError, CalibrateApiClient } from '@calibrate/api-client';

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    });

describe('CalibrateApiClient mobile authentication recovery', () => {
    it('single-flights concurrent refreshes and retries each request once', async () => {
        let accessToken = 'expired-access';
        let refreshCount = 0;
        let initialRequestCount = 0;
        const waitingInitialRequests: Array<() => void> = [];

        const fetchImpl: typeof fetch = async (_input, init) => {
            const authorization = new Headers(init?.headers).get('authorization');
            if (authorization === 'Bearer expired-access') {
                initialRequestCount += 1;
                if (initialRequestCount < 2) {
                    await new Promise<void>((resolve) => waitingInitialRequests.push(resolve));
                } else {
                    waitingInitialRequests.splice(0).forEach((resolve) => resolve());
                }
                return jsonResponse({ message: 'expired' }, 401);
            }

            return jsonResponse({ user: { id: 1 } });
        };

        const client = new CalibrateApiClient({
            baseUrl: 'https://example.test',
            getAccessToken: () => accessToken,
            refreshAccessToken: async () => {
                refreshCount += 1;
                accessToken = 'fresh-access';
                return true;
            },
            fetchImpl
        });

        await Promise.all([client.getMe(), client.getUserProfile()]);

        expect(initialRequestCount).toBe(2);
        expect(refreshCount).toBe(1);
    });

    it('does not rotate again for a late 401 sent with the previous access token', async () => {
        let accessToken = 'expired-access';
        let refreshCount = 0;
        let unauthorizedCount = 0;
        let expiredRequestCount = 0;
        let releaseFirstExpiredRequest!: () => void;
        let releaseLateExpiredRequest!: () => void;
        const firstExpiredRequestStarted = new Promise<void>((resolve) => {
            releaseFirstExpiredRequest = resolve;
        });
        const lateExpiredRequest = new Promise<void>((resolve) => {
            releaseLateExpiredRequest = resolve;
        });
        const client = new CalibrateApiClient({
            baseUrl: 'https://example.test',
            getAccessToken: () => accessToken,
            refreshAccessToken: async () => {
                refreshCount += 1;
                accessToken = 'fresh-access';
                return true;
            },
            onUnauthorized: async () => {
                unauthorizedCount += 1;
            },
            fetchImpl: async (_input, init) => {
                const authorization = new Headers(init?.headers).get('authorization');
                if (authorization === 'Bearer expired-access') {
                    expiredRequestCount += 1;
                    if (expiredRequestCount === 1) {
                        await firstExpiredRequestStarted;
                    } else {
                        releaseFirstExpiredRequest();
                        await lateExpiredRequest;
                    }
                    return jsonResponse({ message: 'expired' }, 401);
                }
                return jsonResponse({ user: { id: 1 } });
            }
        });

        const firstRequest = client.getMe();
        const lateRequest = client.getUserProfile();
        await firstRequest;
        releaseLateExpiredRequest();
        await lateRequest;

        expect(expiredRequestCount).toBe(2);
        expect(refreshCount).toBe(1);
        expect(unauthorizedCount).toBe(0);
    });

    it('retries only once before clearing an unauthorized session', async () => {
        let requestCount = 0;
        let refreshCount = 0;
        let unauthorizedCount = 0;
        const client = new CalibrateApiClient({
            baseUrl: 'https://example.test',
            getAccessToken: () => 'rejected-access',
            refreshAccessToken: async () => {
                refreshCount += 1;
                return true;
            },
            onUnauthorized: async () => {
                unauthorizedCount += 1;
            },
            fetchImpl: async () => {
                requestCount += 1;
                return jsonResponse({ message: 'still rejected' }, 401);
            }
        });

        await expect(client.getMe()).rejects.toBeInstanceOf(ApiError);
        expect(requestCount).toBe(2);
        expect(refreshCount).toBe(1);
        expect(unauthorizedCount).toBe(1);
    });

    it('preserves the session when refresh is temporarily unavailable', async () => {
        let unauthorizedCount = 0;
        const client = new CalibrateApiClient({
            baseUrl: 'https://example.test',
            getAccessToken: () => 'expired-access',
            refreshAccessToken: async () => {
                throw new Error('refresh network unavailable');
            },
            onUnauthorized: async () => {
                unauthorizedCount += 1;
            },
            fetchImpl: async () => jsonResponse({ message: 'expired' }, 401)
        });

        await expect(client.getMe()).rejects.toThrow('refresh network unavailable');
        expect(unauthorizedCount).toBe(0);
    });

    it('logs out by refresh token without requiring a valid access token', async () => {
        let refreshCount = 0;
        let authorization: string | null = 'not-called';
        const client = new CalibrateApiClient({
            baseUrl: 'https://example.test',
            getAccessToken: () => 'expired-access',
            refreshAccessToken: async () => {
                refreshCount += 1;
                return true;
            },
            fetchImpl: async (_input, init) => {
                authorization = new Headers(init?.headers).get('authorization');
                return jsonResponse({ ok: true });
            }
        });

        await client.logoutMobile('refresh-token');

        expect(authorization).toBeNull();
        expect(refreshCount).toBe(0);
    });
});

describe('CalibrateApiClient v1 wire behavior', () => {
    it('uses the v1 API mount and resolves 204 responses as undefined', async () => {
        let requestedUrl = '';
        const client = new CalibrateApiClient({
            baseUrl: 'https://example.test/',
            fetchImpl: async (input) => {
                requestedUrl = String(input);
                return new Response(null, { status: 204 });
            }
        });

        await expect(client.deleteFoodLog(17)).resolves.toBeUndefined();
        expect(requestedUrl).toBe('https://example.test/api/v1/food/17');
    });

    it('surfaces non-JSON gateway failures as ApiError instead of a parse exception', async () => {
        const client = new CalibrateApiClient({
            baseUrl: 'https://example.test',
            fetchImpl: async () => new Response('<html>bad gateway</html>', { status: 502 })
        });

        await expect(client.getClientConfig()).rejects.toMatchObject({
            name: 'ApiError',
            status: 502,
            body: '<html>bad gateway</html>',
            message: 'Request failed with status 502'
        });
    });
});

it.each([408, 429, 500, 502, 503])('observes the completed retryable HTTP %s failure without unauthorized cleanup', async (status) => {
    const onUnauthorized = jest.fn();
    const onRequestError = jest.fn();
    const client = new CalibrateApiClient({
        baseUrl: 'https://example.test', onRequestError, onUnauthorized,
        fetchImpl: async () => jsonResponse({ error: 'Unavailable', retryable: true }, status)
    });
    await expect(client.getMe()).rejects.toMatchObject({ status, retryable: true });
    expect(onRequestError).toHaveBeenCalledWith(expect.objectContaining({ status, retryable: true }));
    expect(onUnauthorized).not.toHaveBeenCalled();
});

it('observes the API-generated timeout even when fetch ignores abort', async () => {
    const onRequestError = jest.fn();
    const client = new CalibrateApiClient({
        baseUrl: 'https://example.test', requestTimeoutMs: 10, onRequestError,
        fetchImpl: () => new Promise<Response>(() => undefined)
    });
    await expect(client.getMe()).rejects.toThrow('Request timed out while connecting to');
    expect(onRequestError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Request timed out while connecting to') }));
});
