/** @file Federated credential boundaries: expiry, concurrent exchange, mapping isolation and sanitized retryable failures. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { getOpenAIWorkloadAccessToken, invalidateOpenAIWorkloadAccessToken } = require('../src/services/weeklyReports/workloadIdentity');
const config = name => ({ identityProviderId: `idp-${name}`, serviceAccountId: 'sa-report', audience: 'https://api.openai.com/v1' });
const signal = () => new AbortController().signal;
const credential = (token, expiry = Math.floor(Date.now() / 1000) + 3600) => ({ access_token: token, token_type: 'Bearer', expires_at: expiry, expires_in: 3600 });

test('exchanges only attached Google identity, coalesces concurrent requests and reuses the resulting credential', async t => {
    const mapping = config('concurrent');
    const requests = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.mock.method(global, 'fetch', async (url, options) => {
        requests.push({ url, options });
        if (requests.length === 1) {
            await gate;
            return { ok: true, text: async () => 'google-subject-token' };
        }
        return { ok: true, json: async () => credential('openai-access-token') };
    });
    const first = getOpenAIWorkloadAccessToken(mapping, signal());
    const second = getOpenAIWorkloadAccessToken(mapping, signal());
    assert.equal(requests.length, 1);
    release();
    assert.deepEqual(await Promise.all([first, second]), ['openai-access-token', 'openai-access-token']);
    assert.equal(await getOpenAIWorkloadAccessToken(mapping, signal()), 'openai-access-token');
    assert.equal(requests.length, 2);
    const metadata = requests[0];
    assert.equal(metadata.url.origin, 'http://metadata.google.internal');
    assert.equal(metadata.url.pathname, '/computeMetadata/v1/instance/service-accounts/default/identity');
    assert.equal(metadata.url.searchParams.get('audience'), mapping.audience);
    assert.equal(metadata.options.headers['Metadata-Flavor'], 'Google');
    const exchange = requests[1];
    assert.equal(exchange.url, 'https://auth.openai.com/oauth/token');
    assert.equal(exchange.options.redirect, 'error');
    assert.equal(metadata.options.redirect, 'error');
    assert.deepEqual(JSON.parse(exchange.options.body), {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        subject_token: 'google-subject-token', identity_provider_id: mapping.identityProviderId, service_account_id: mapping.serviceAccountId
    });
});

test('refreshes before absolute expiration, binds cache to all mapping fields and invalidates only the rejected token', async t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    let exchanges = 0;
    t.mock.method(global, 'fetch', async url => {
        if (String(url).startsWith('http://metadata.google.internal/')) return { ok: true, text: async () => 'google-token' };
        return { ok: true, json: async () => credential(`token-${++exchanges}`) };
    });
    const mapping = config('expiry');
    assert.equal(await getOpenAIWorkloadAccessToken(mapping, signal()), 'token-1');
    now += 3541 * 1000;
    assert.equal(await getOpenAIWorkloadAccessToken(mapping, signal()), 'token-2');
    invalidateOpenAIWorkloadAccessToken(mapping, 'token-1');
    assert.equal(await getOpenAIWorkloadAccessToken(mapping, signal()), 'token-2');
    invalidateOpenAIWorkloadAccessToken(mapping, 'token-2');
    assert.equal(await getOpenAIWorkloadAccessToken(mapping, signal()), 'token-3');
    for (const changed of [
        { ...mapping, serviceAccountId: 'sa-other' },
        { ...mapping, identityProviderId: 'idp-other' },
        { ...mapping, audience: 'https://example.invalid/custom-audience' }
    ]) await getOpenAIWorkloadAccessToken(changed, signal());
    assert.equal(exchanges, 6);
});

test('rejects expired or malformed credentials without exposing token bodies, and permits a fresh retry', async t => {
    let payload;
    t.mock.method(global, 'fetch', async url => {
        if (String(url).startsWith('http://metadata.google.internal/')) return { ok: true, text: async () => 'sensitive-subject' };
        return { ok: true, json: async () => payload };
    });
    const mapping = config('invalid');
    for (const invalid of [
        credential('sensitive-expired', Math.floor(Date.now() / 1000) - 1),
        credential('sensitive-near-expiry', Math.floor(Date.now() / 1000) + 30),
        { ...credential('sensitive-token'), token_type: 'unexpected' },
        { ...credential('sensitive-token'), expires_at: undefined },
        credential('invalid\r\nheader')
    ]) {
        payload = invalid;
        await assert.rejects(getOpenAIWorkloadAccessToken(mapping, signal()), error => {
            assert.match(error.message, /workload identity exchange failed/);
            assert.doesNotMatch(error.message, /sensitive|invalid\r/);
            assert.equal(error.cause, undefined);
            return true;
        });
    }
    payload = credential('recovered-token');
    assert.equal(await getOpenAIWorkloadAccessToken(mapping, signal()), 'recovered-token');
});

test('metadata outages, exchange rejection and cancellation never fall back to an API key', async t => {
    let calls = 0;
    let failure = 'metadata';
    t.mock.method(global, 'fetch', async url => {
        calls++;
        if (String(url).startsWith('http://metadata.google.internal/')) {
            if (failure === 'metadata') throw new Error('sensitive transport details');
            return { ok: true, text: async () => 'subject-token' };
        }
        return { ok: false, status: 403, json: async () => { throw new Error('Error bodies must not be read'); } };
    });
    await assert.rejects(getOpenAIWorkloadAccessToken(config('outage'), signal()), /exchange failed/);
    assert.equal(calls, 1);
    failure = 'exchange';
    await assert.rejects(getOpenAIWorkloadAccessToken(config('outage'), signal()), /exchange failed/);
    assert.equal(calls, 3);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(getOpenAIWorkloadAccessToken(config('outage'), controller.signal));
    assert.equal(calls, 3);
});
