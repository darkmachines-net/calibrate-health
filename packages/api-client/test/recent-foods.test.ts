/** @file Regression coverage for recent foods: getRecentFoods includes selected meal context in the query string. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

test('getRecentFoods includes selected meal context in the query string', async () => {
    let capturedUrl = '';
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input) => {
            capturedUrl = String(input);
            return new Response(JSON.stringify({ items: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as typeof fetch
    });

    await client.getRecentFoods({
        q: 'greek yogurt',
        limit: 8,
        meal_period: 'AFTERNOON_SNACK'
    });

    assert.equal(
        capturedUrl,
        'https://calibrate.example/api/v1/food/recent?q=greek+yogurt&limit=8&meal_period=AFTERNOON_SNACK'
    );
});
