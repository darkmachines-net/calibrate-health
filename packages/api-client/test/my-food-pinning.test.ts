/** @file Regression coverage for my food pinning: setMyFoodPinned sends an ownership-safe resource patch payload. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

test('setMyFoodPinned sends an ownership-safe resource patch payload', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit = {};
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input, init) => {
            capturedUrl = String(input);
            capturedInit = init ?? {};
            return new Response(JSON.stringify({
                id: 42,
                type: 'FOOD',
                name: 'Oats',
                serving_size_quantity: 1,
                serving_unit_label: 'serving',
                calories_per_serving: 180,
                is_pinned: true
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch
    });

    const result = await client.setMyFoodPinned(42, true);

    assert.equal(capturedUrl, 'https://calibrate.example/api/v1/my-foods/42/pin');
    assert.equal(capturedInit.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(capturedInit.body)), { is_pinned: true });
    assert.equal(result.is_pinned, true);
});
