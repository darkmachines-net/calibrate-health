/** @file Native provider exchanges stay unauthenticated while deletion keeps the current Calibrate session. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

test('provider discovery and credential exchange use the configured origin without stale bearer tokens', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example', getAccessToken: () => 'old-session',
        fetchImpl: async (input, init) => {
            requests.push({ url: String(input), init });
            return new Response(JSON.stringify({ providers: ['google.com'] }), { status: 200 });
        }
    });
    await client.getMobileSocialProviders();
    await client.authenticateMobileSocial({ provider: 'google.com', id_token: 'ephemeral', intent: 'login', device_id: 'device' });
    assert.equal(requests[0].url, 'https://calibrate.example/auth/mobile/providers');
    assert.equal(requests[1].url, 'https://calibrate.example/auth/mobile/social');
    assert.equal(new Headers(requests[1].init?.headers).get('Authorization'), null);
    assert.equal(JSON.parse(String(requests[1].init?.body)).id_token, 'ephemeral');
});

test('provider account deletion retains bearer authorization and sends proof in the body', async () => {
    let request: RequestInit | undefined;
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example', getAccessToken: () => 'current-session',
        fetchImpl: async (_input, init) => { request = init; return new Response(null, { status: 204 }); }
    });
    await client.deleteAccount({ provider: 'apple.com', id_token: 'ephemeral', nonce: 'raw-nonce' });
    assert.equal(request?.method, 'DELETE');
    assert.equal(new Headers(request?.headers).get('Authorization'), 'Bearer current-session');
    assert.deepEqual(JSON.parse(String(request?.body)), { provider_credential: { provider: 'apple.com', id_token: 'ephemeral', nonce: 'raw-nonce' } });
});
