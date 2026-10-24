/** @file Regression coverage for account access: registration sends explicit legal versions and acceptance. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

type CapturedRequest = { url: string; init: RequestInit };

const FULL_ACCESS = {
    state: 'full' as const,
    email_verified: true,
    legal_current: true
};

const LEGAL_STATUS = {
    account_access: FULL_ACCESS,
    required: {
        terms_version: '2026-08-09',
        privacy_version: '2026-07-24'
    },
    accepted: {
        terms_version: '2026-08-09',
        privacy_version: '2026-07-24',
        accepted_at: '2026-08-09T12:00:00.000Z'
    }
};

const createClient = (requests: CapturedRequest[]): CalibrateApiClient =>
    new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        getAccessToken: () => 'access-token',
        fetchImpl: (async (input, init) => {
            requests.push({ url: String(input), init: init ?? {} });
            const path = new URL(String(input)).pathname;
            let body: unknown = { message: 'If the account exists, instructions will be sent.' };
            if (path.endsWith('/email-verification/confirm')) {
                body = { message: 'Email verified.', account_access: FULL_ACCESS };
            } else if (path.startsWith('/api/v1/legal/')) {
                body = LEGAL_STATUS;
            } else if (path.endsWith('/register')) {
                body = { user: { id: 1, email: 'new@example.com', account_access: FULL_ACCESS } };
            }
            return new Response(JSON.stringify(body), {
                status: path.endsWith('/resend') || path.endsWith('/request') ? 202 : 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as typeof fetch
    });

const requestJson = (request: CapturedRequest): unknown => JSON.parse(String(request.init.body));

test('registration sends explicit legal versions and acceptance', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.registerBrowser({
        email: 'new@example.com',
        password: 'password123',
        terms_version: '2026-08-09',
        privacy_version: '2026-07-24',
        accept_terms: true,
        accept_privacy: true
    });

    assert.equal(requests[0]?.url, 'https://calibrate.example/auth/register');
    assert.deepEqual(requestJson(requests[0]!), {
        email: 'new@example.com',
        password: 'password123',
        terms_version: '2026-08-09',
        privacy_version: '2026-07-24',
        accept_terms: true,
        accept_privacy: true
    });
});

test('email verification endpoints remain usable before full account access', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.resendEmailVerification({ email: 'person@example.com' });
    const confirmed = await client.confirmEmailVerification({ token: 'verification-token' });

    assert.equal(requests[0]?.url, 'https://calibrate.example/auth/email-verification/resend');
    assert.equal(requests[1]?.url, 'https://calibrate.example/auth/email-verification/confirm');
    assert.equal(new Headers(requests[0]?.init.headers).get('authorization'), 'Bearer access-token');
    assert.equal(new Headers(requests[1]?.init.headers).get('authorization'), null);
    assert.deepEqual(requestJson(requests[0]!), { email: 'person@example.com' });
    assert.deepEqual(requestJson(requests[1]!), { token: 'verification-token' });
    assert.deepEqual(confirmed.account_access, FULL_ACCESS);
});

test('password recovery uses generic public endpoints and the new_password wire field', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.requestPasswordReset({ email: 'person@example.com' });
    await client.confirmPasswordReset({ token: 'reset-token', new_password: 'replacement123' });

    assert.equal(requests[0]?.url, 'https://calibrate.example/auth/password-reset/request');
    assert.equal(requests[1]?.url, 'https://calibrate.example/auth/password-reset/confirm');
    assert.deepEqual(requestJson(requests[1]!), {
        token: 'reset-token',
        new_password: 'replacement123'
    });
});

test('legal status and acceptance use authenticated v1 routes', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    const status = await client.getLegalStatus();
    const accepted = await client.acceptLegalDocuments({
        terms_version: '2026-08-09',
        privacy_version: '2026-07-24',
        accept_terms: true,
        accept_privacy: true
    });

    assert.equal(requests[0]?.url, 'https://calibrate.example/api/v1/legal/status');
    assert.equal(requests[1]?.url, 'https://calibrate.example/api/v1/legal/acceptance');
    assert.equal(new Headers(requests[0]?.init.headers).get('authorization'), 'Bearer access-token');
    assert.equal(requests[1]?.init.method, 'POST');
    assert.deepEqual(requestJson(requests[1]!), {
        terms_version: '2026-08-09',
        privacy_version: '2026-07-24',
        accept_terms: true,
        accept_privacy: true
    });
    assert.deepEqual(status, LEGAL_STATUS);
    assert.deepEqual(accepted, LEGAL_STATUS);
});
