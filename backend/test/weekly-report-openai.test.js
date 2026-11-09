/** @file Federated provider request privacy, output validation and rejected-token recovery without live model calls. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeWeeklyProgress, getWeeklyReportConfiguration } = require('../src/services/weeklyReports/openai');
const evidence = { tracking: { windows: [], needsWeighIn: true }, language: 'en', goal: null };
const valid = { summary: 'You logged four days.', highlights: ['Weight needs a fresh reading.'], nextStep: 'Log your weight.' };

test('requires the federation mapping and model; an API key alone never enables generation', () => {
    assert.equal(getWeeklyReportConfiguration({}), null);
    assert.equal(getWeeklyReportConfiguration({ OPENAI_API_KEY: 'test', OPENAI_WEEKLY_REPORT_MODEL: 'test' }), null);
    assert.equal(getWeeklyReportConfiguration({ OPENAI_IDENTITY_PROVIDER_ID: 'idp-test', OPENAI_WEEKLY_REPORT_MODEL: 'test' }), null);
    assert.equal(getWeeklyReportConfiguration({ OPENAI_SERVICE_ACCOUNT_ID: 'sa-test', OPENAI_WEEKLY_REPORT_MODEL: 'test' }), null);
    assert.equal(getWeeklyReportConfiguration({ OPENAI_IDENTITY_PROVIDER_ID: 'idp-test', OPENAI_SERVICE_ACCOUNT_ID: 'sa-test' }), null);
    assert.deepEqual(getWeeklyReportConfiguration({ OPENAI_IDENTITY_PROVIDER_ID: ' idp-test ', OPENAI_SERVICE_ACCOUNT_ID: ' sa-test ', OPENAI_WEEKLY_REPORT_MODEL: ' chosen-model ' }),
        { identityProviderId: 'idp-test', serviceAccountId: 'sa-test', audience: 'https://api.openai.com/v1', model: 'chosen-model' });
});

test('uses minimal evidence, non-stored structured output and rejects unsafe provider response shapes', async (t) => {
    const values = { OPENAI_IDENTITY_PROVIDER_ID: 'idp-provider-test', OPENAI_SERVICE_ACCOUNT_ID: 'sa-provider-test', OPENAI_WEEKLY_REPORT_MODEL: 'test-model' };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    t.after(() => Object.entries(previous).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; }));
    let request;
    let unauthorized = false;
    let exchanges = 0;
    let payload = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(valid) }] }] };
    t.mock.method(global, 'fetch', async (url, options) => {
        if (String(url).startsWith('http://metadata.google.internal/')) return { ok: true, text: async () => 'synthetic-google-token' };
        if (url === 'https://auth.openai.com/oauth/token') {
            exchanges++;
            return { ok: true, json: async () => ({ access_token: 'synthetic-openai-token', token_type: 'Bearer', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600 }) };
        }
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(options.headers.Authorization, 'Bearer synthetic-openai-token');
        assert.equal(options.redirect, 'error');
        request = JSON.parse(options.body);
        return { ok: !unauthorized, status: unauthorized ? 401 : 200, json: async () => payload };
    });
    assert.deepEqual(await analyzeWeeklyProgress(evidence), valid);
    assert.equal(request.store, false);
    assert.equal(request.model, 'test-model');
    assert.equal(request.text.format.strict, true);
    assert.deepEqual(JSON.parse(request.input), evidence);
    assert.match(request.instructions, /Never infer TDEE/);
    for (const invalid of [
        { status: 'incomplete' },
        { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] },
        { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] },
        { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] }
    ]) {
        payload = invalid;
        await assert.rejects(analyzeWeeklyProgress(evidence));
    }
    assert.equal(exchanges, 1);
    unauthorized = true;
    await assert.rejects(analyzeWeeklyProgress(evidence), /HTTP 401/);
    unauthorized = false;
    payload = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(valid) }] }] };
    assert.deepEqual(await analyzeWeeklyProgress(evidence), valid);
    assert.equal(exchanges, 2);
});
