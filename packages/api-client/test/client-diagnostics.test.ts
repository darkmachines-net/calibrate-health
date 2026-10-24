/** @file Regression coverage for client diagnostics: root-render failure remains anonymous and normal diagnostics do not request keepalive. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';
import type { ClientDiagnosticInput } from '../src/types.ts';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

const acceptedResponse = () => new Response(JSON.stringify({ ok: true, request_id: REQUEST_ID }), {
    status: 202,
    headers: { 'content-type': 'application/json' }
});

test('root-render failure remains anonymous and normal diagnostics do not request keepalive', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const input: ClientDiagnosticInput = {
        event: 'client_failure',
        operation: 'root_render',
        route: 'app_shell',
        platform: 'web',
        version: '0.33.6',
        outcome: 'failure',
        duration_bucket: 'not_applicable',
        request_id: REQUEST_ID
    };
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        getAccessToken: () => 'must-not-be-read',
        fetchImpl: (async (request, init) => {
            requests.push({ url: String(request), init: init ?? {} });
            return acceptedResponse();
        }) as typeof fetch
    });

    assert.deepEqual(await client.reportClientDiagnostic(input), { ok: true, request_id: REQUEST_ID });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, 'https://calibrate.example/api/v1/client-diagnostics');
    assert.equal(requests[0]?.init.method, 'POST');
    assert.equal(requests[0]?.init.keepalive, undefined);
    const headers = new Headers(requests[0]?.init.headers);
    assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('x-correlation-id'), REQUEST_ID);
    assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), input);
});

test('native feature diagnostics attach bearer identity and use the normal 401 refresh path', async () => {
    const authorizationHeaders: Array<string | null> = [];
    const input: ClientDiagnosticInput = {
        event: 'operation_failure',
        operation: 'saved_foods_load',
        route: 'saved_foods',
        platform: 'android_phone',
        version: '0.2.5',
        outcome: 'failure',
        duration_bucket: 'not_applicable'
    };
    let accessToken = 'expired-token';
    let refreshCount = 0;
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        clientIdentity: { platform: 'android_phone', version: '0.2.5' },
        getAccessToken: () => accessToken,
        refreshAccessToken: () => {
            refreshCount += 1;
            accessToken = 'replacement-token';
            return true;
        },
        fetchImpl: (async (_request, init) => {
            const headers = new Headers(init?.headers);
            authorizationHeaders.push(headers.get('authorization'));
            assert.equal(headers.get('x-calibrate-client-platform'), 'android_phone');
            assert.equal(headers.get('x-calibrate-client-version'), '0.2.5');
            assert.equal(init?.keepalive, undefined);
            if (authorizationHeaders.length === 1) {
                return new Response(JSON.stringify({ message: 'Not authenticated' }), {
                    status: 401,
                    headers: { 'content-type': 'application/json' }
                });
            }
            return acceptedResponse();
        }) as typeof fetch
    });

    assert.deepEqual(await client.reportClientDiagnostic(input), { ok: true, request_id: REQUEST_ID });
    assert.equal(refreshCount, 1);
    assert.deepEqual(authorizationHeaders, ['Bearer expired-token', 'Bearer replacement-token']);
});

test('web-vital diagnostics use authenticated unload-safe transport', async () => {
    const requests: RequestInit[] = [];
    const input: ClientDiagnosticInput = {
        event: 'web_vital',
        operation: 'interaction_to_next_paint',
        route: 'today',
        platform: 'web',
        version: '0.13.3',
        outcome: 'needs_improvement',
        duration_bucket: '200_to_500_ms'
    };
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        getAccessToken: () => 'web-access-token',
        fetchImpl: (async (_request, init) => {
            requests.push(init ?? {});
            return acceptedResponse();
        }) as typeof fetch
    });

    await client.reportClientDiagnostic(input);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.keepalive, true);
    assert.equal(new Headers(requests[0]?.headers).get('authorization'), 'Bearer web-access-token');
});
