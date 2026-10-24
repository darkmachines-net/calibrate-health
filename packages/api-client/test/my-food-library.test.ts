/** @file Regression coverage for my food library: getMyFoodsLibrary encodes filters and returns the paged envelope. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

test('getMyFoodsLibrary encodes filters and returns the paged envelope', async () => {
    let capturedUrl = '';
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input) => {
            capturedUrl = String(input);
            return new Response(JSON.stringify({
                items: [{
                    id: 42,
                    type: 'RECIPE',
                    name: 'Bean bowl',
                    serving_size_quantity: 1,
                    serving_unit_label: 'bowl',
                    calories_per_serving: 420,
                    is_pinned: true,
                    recipe_total_calories: 840,
                    yield_servings: 2
                }],
                next_cursor: 'opaque_cursor'
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch
    });

    const result = await client.getMyFoodsLibrary({
        q: 'bean bowl',
        type: 'RECIPE',
        cursor: 'previous_cursor',
        limit: 20
    });

    assert.equal(
        capturedUrl,
        'https://calibrate.example/api/v1/my-foods/library?q=bean+bowl&type=RECIPE&cursor=previous_cursor&limit=20'
    );
    assert.equal(result.items[0]?.id, 42);
    assert.equal(result.next_cursor, 'opaque_cursor');
});

test('getMyFoodsLibrary omits absent query parameters', async () => {
    let capturedUrl = '';
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input) => {
            capturedUrl = String(input);
            return new Response(JSON.stringify({ items: [], next_cursor: null }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as typeof fetch
    });

    await client.getMyFoodsLibrary();

    assert.equal(capturedUrl, 'https://calibrate.example/api/v1/my-foods/library');
});
