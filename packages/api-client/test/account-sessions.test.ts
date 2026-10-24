/** @file Regression coverage for account sessions: unified account-session methods use the locked list and revocation wire. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

test('unified account-session methods use the locked list and revocation wire', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const sessionId = 'mobile_22222222-2222-4222-8222-222222222222';
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input, init) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            requests.push({ url, method });
            if (url.endsWith('/revoke-others')) {
                return new Response(JSON.stringify({ ok: true, revoked: 2 }), { status: 200 });
            }
            if (method === 'DELETE') {
                return new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 });
            }
            return new Response(JSON.stringify({
                sessions: [{
                    id: 'browser_11111111-1111-4111-8111-111111111111',
                    kind: 'browser',
                    device_label: null,
                    created_at: '2026-08-09T09:00:00.000Z',
                    last_activity_at: '2026-08-09T12:00:00.000Z',
                    current: true
                }]
            }), { status: 200 });
        }) as typeof fetch
    });

    assert.equal((await client.getAccountSessions()).sessions[0].current, true);
    assert.deepEqual(await client.revokeAccountSession(sessionId), { ok: true, revoked: true });
    assert.deepEqual(await client.revokeOtherAccountSessions(), { ok: true, revoked: 2 });
    assert.deepEqual(requests, [
        { url: 'https://calibrate.example/auth/sessions', method: 'GET' },
        { url: `https://calibrate.example/auth/sessions/${sessionId}`, method: 'DELETE' },
        { url: 'https://calibrate.example/auth/sessions/revoke-others', method: 'POST' }
    ]);
});
