/** @file Regression coverage for my food editing: updateMyFood patches the owned resource with a typed snapshot definition. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';
import type { CreateRecipeFromFoodLogsPayload, CreateRecipePayload } from '../src/types.ts';

test('updateMyFood patches the owned resource with a typed snapshot definition', async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input, init) => {
            request = { url: String(input), init: init ?? {} };
            return new Response(JSON.stringify({ id: 5 }), { status: 200 });
        }) as typeof fetch
    });
    const payload = {
        name: 'Oats',
        serving_size_quantity: 1,
        serving_unit_label: 'bowl',
        calories_per_serving: 180
    };
    await client.updateMyFood(5, payload);
    assert.equal(request?.url, 'https://calibrate.example/api/v1/my-foods/5');
    assert.equal(request?.init.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(request?.init.body)), payload);
});

test('deleteMyFood deletes the resource and accepts an empty response', async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input, init) => {
            request = { url: String(input), init: init ?? {} };
            return new Response(null, { status: 204 });
        }) as typeof fetch
    });
    await client.deleteMyFood(5);
    assert.equal(request?.url, 'https://calibrate.example/api/v1/my-foods/5');
    assert.equal(request?.init.method, 'DELETE');
});

test('createRecipeFromFoodLogs posts the ordered food log snapshot request', async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input, init) => {
            request = { url: String(input), init: init ?? {} };
            return new Response(JSON.stringify({ id: 9 }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as typeof fetch
    });
    const payload = {
        name: 'Margarita',
        yield_servings: 2,
        food_log_ids: [22, 11]
    } satisfies CreateRecipeFromFoodLogsPayload;

    await client.createRecipeFromFoodLogs(payload);

    assert.equal(request?.url, 'https://calibrate.example/api/v1/my-foods/recipes/from-food-logs');
    assert.equal(request?.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(request?.init.body)), payload);
});

test('external recipe ingredient types preserve serving snapshots for editing', () => {
    const payload = {
        name: 'Margarita',
        serving_size_quantity: 1,
        serving_unit_label: 'serving',
        yield_servings: 1,
        ingredients: [{
            source: 'EXTERNAL',
            name: 'Tequila',
            calories_total: 194,
            quantity_servings: 1.5,
            serving_size_quantity: 1,
            serving_unit_label: 'fl oz',
            calories_per_serving: 129.3333333333
        }]
    } satisfies CreateRecipePayload;

    assert.equal(payload.ingredients[0].quantity_servings, 1.5);
});
