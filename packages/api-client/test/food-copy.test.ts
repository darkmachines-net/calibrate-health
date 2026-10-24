/** @file Regression coverage for food copy: copyFoodLogs sends the atomic copy payload and returns the committed receipt. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';
import type { FoodLogCopyPayload } from '../src/types.ts';

test('copyFoodLogs sends the atomic copy payload and returns the committed receipt', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const responseBody = {
        operation_id: 'food-copy-client-001',
        source_date: '2026-08-08',
        target_date: '2026-08-09',
        copied_count: 1,
        food_logs: [{ id: 42, meal_period: 'DINNER', name: 'Lunch', calories: 410 }]
    };
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input, init) => {
            capturedUrl = String(input);
            capturedInit = init;
            return new Response(JSON.stringify(responseBody), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as typeof fetch
    });
    const payload: FoodLogCopyPayload = {
        operation_id: 'food-copy-client-001',
        source_date: '2026-08-08',
        target_date: '2026-08-09',
        meal_mappings: [{ source_meal_period: 'LUNCH', target_meal_period: 'DINNER' }]
    };

    const response = await client.copyFoodLogs(payload);

    assert.equal(capturedUrl, 'https://calibrate.example/api/v1/food/copy');
    assert.equal(capturedInit?.method, 'POST');
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), payload);
    assert.equal(new Headers(capturedInit?.headers).get('x-client-operation-id'), null);
    assert.deepEqual(response, responseBody);
});
