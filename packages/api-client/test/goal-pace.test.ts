/** @file Regression coverage for goal pace: pace preview bypasses cache and adjustment retries retain operation and expected version. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';
test('pace preview bypasses cache and adjustment retries retain operation and expected version', async () => {
    const calls: Array<{
        url: string;
        init?: RequestInit;
    }> = [];
    const client = new CalibrateApiClient({ baseUrl: 'https://calibrate.example', fetchImpl: async (url, init) => {
            calls.push({ url: String(url), init });
            return new Response(JSON.stringify({ id: 4, start_weight: 90, target_weight: 75, daily_deficit: 250, created_at: '2025-01-01T00:00:00Z' }));
        } });
    await client.getGoalPaceOptions();
    assert.equal(calls[0].init?.cache, 'no-store');
    const body = { daily_deficit: 250, expected_plan_version: 'a'.repeat(64) };
    const first = await client.adjustGoalPace(4, body, 'stable-operation-001');
    await client.adjustGoalPace(4, body, 'stable-operation-001');
    assert.equal(first.start_weight, 90);
    assert.ok(calls[1].url.endsWith('/api/v1/goals/4/pace'));
    assert.equal(calls[1].init?.method, 'PATCH');
    assert.equal(new Headers(calls[1].init?.headers).get('x-client-operation-id'), 'stable-operation-001');
    assert.equal(calls[1].init?.body, calls[2].init?.body);
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), body);
});
