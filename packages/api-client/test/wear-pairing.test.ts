/** @file Regression coverage for wear pairing: phone pairing issuance is authenticated and carries the selected self-hosted origin. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

type CapturedRequest = { url: string; init: RequestInit };

function createClient(requests: CapturedRequest[]): CalibrateApiClient {
    return new CalibrateApiClient({
        baseUrl: 'https://self-hosted.example',
        getAccessToken: () => 'phone-access-token',
        fetchImpl: (async (input, init) => {
            requests.push({ url: String(input), init: init ?? {} });
            return new Response(JSON.stringify({}), { status: 200 });
        }) as typeof fetch
    });
}

test('phone pairing issuance is authenticated and carries the selected self-hosted origin', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    const payload = {
        server_origin: 'https://self-hosted.example',
        watch_device_id: 'watch-install-1',
        watch_device_name: 'Galaxy Watch Ultra',
        protocol_version: 1 as const,
        watch_public_key_spki: 'base64-spki'
    };
    await client.issueWearPairingCredential(payload);

    assert.equal(requests[0]?.url, 'https://self-hosted.example/auth/mobile/wear/pairing-credential');
    assert.equal(new Headers(requests[0]?.init.headers).get('authorization'), 'Bearer phone-access-token');
    assert.equal(requests[0]?.init.body, JSON.stringify(payload));
});

test('Wear exchange is unauthenticated and sends the server-bound one-time credential', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);
    const payload = {
        pairing_token: 'wear_pair_secret',
        server_origin: 'https://self-hosted.example',
        watch_device_id: 'watch-install-1',
        protocol_version: 1 as const,
        exchange_id: 'f6ca2d91-d450-4ee0-9f09-7c66e6eb7358',
        challenge_signature: 'base64url-der-signature'
    };

    await client.exchangeWearPairingCredential(payload);

    assert.equal(requests[0]?.url, 'https://self-hosted.example/auth/mobile/wear/pair');
    assert.equal(new Headers(requests[0]?.init.headers).get('authorization'), null);
    assert.equal(requests[0]?.init.body, JSON.stringify(payload));
});
