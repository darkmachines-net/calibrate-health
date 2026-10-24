/** @file Regression coverage for client operation id: createFoodLog sends the caller operation ID. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

type CapturedRequest = {
    url: string;
    init: RequestInit;
};

const createClient = (requests: CapturedRequest[]): CalibrateApiClient =>
    new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input, init) => {
            requests.push({ url: String(input), init: init ?? {} });
            return new Response('{}', {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as typeof fetch
    });

const getOperationId = (request: CapturedRequest): string | null =>
    new Headers(request.init.headers).get('x-client-operation-id');

test('createFoodLog sends the caller operation ID', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.createFoodLog(
        {
            name: 'Apple',
            calories: 95,
            meal_period: 'BREAKFAST',
            date: '2026-07-11'
        },
        'food-operation-1'
    );

    assert.equal(requests[0]?.url, 'https://calibrate.example/api/v1/food');
    assert.equal(getOperationId(requests[0]), 'food-operation-1');
});

test('addMetric sends the caller operation ID for metric upserts', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.addMetric({ weight: 82.5, date: '2026-07-11' }, 'metric-operation-1');

    assert.equal(requests[0]?.url, 'https://calibrate.example/api/v1/metrics');
    assert.equal(getOperationId(requests[0]), 'metric-operation-1');
});

test('updateFoodDay sends the caller operation ID for completion changes', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.updateFoodDay(
        { date: '2026-07-11', is_complete: true },
        'food-day-operation-1'
    );

    assert.equal(requests[0]?.url, 'https://calibrate.example/api/v1/food-days');
    assert.equal(getOperationId(requests[0]), 'food-day-operation-1');
});

test('day status and pause lifecycle methods preserve caller operation IDs and local dates', async () => {
    const calls: CapturedRequest[] = [];
    const client = createClient(calls);

    await client.setFoodDayStatus(
        { date: '2026-07-11', status: 'INCOMPLETE' },
        'day-status-operation'
    );
    assert.equal(getOperationId(calls[0]), 'day-status-operation');
    assert.match(String(calls[0].init.body), /2026-07-11/);

    calls.length = 0;
    await client.startFoodTrackingPause(
        { starts_on: '2026-07-11', expected_resume_on: '2026-07-14' },
        'pause-start-operation'
    );
    assert.equal(getOperationId(calls[0]), 'pause-start-operation');
    assert.match(String(calls[0].init.body), /2026-07-14/);

    calls.length = 0;
    await client.resumeFoodTracking({ resumed_on: '2026-07-13' }, 'pause-resume-operation');
    assert.equal(getOperationId(calls[0]), 'pause-resume-operation');
    assert.match(String(calls[0].init.body), /2026-07-13/);
});

test('createGoal sends the caller operation ID', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.createGoal(
        { start_weight: 82, target_weight: 76, daily_deficit: 500 },
        'goal-operation-1'
    );

    assert.equal(getOperationId(requests[0]), 'goal-operation-1');
});

test('updatePreferences sends the caller operation ID', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.updatePreferences({ weight_unit: 'KG' }, 'preferences-operation-1');

    assert.equal(getOperationId(requests[0]), 'preferences-operation-1');
});

test('updateFoodLog sends the caller operation ID', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.updateFoodLog(42, { calories: 420 }, 'food-update-operation-1');

    assert.equal(requests[0]?.url, 'https://calibrate.example/api/v1/food/42');
    assert.equal(requests[0]?.init.method, 'PATCH');
    assert.equal(getOperationId(requests[0]), 'food-update-operation-1');
});

test('deleteFoodLog sends the caller operation ID', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.deleteFoodLog(42, 'food-delete-operation-1');

    assert.equal(requests[0]?.url, 'https://calibrate.example/api/v1/food/42');
    assert.equal(requests[0]?.init.method, 'DELETE');
    assert.equal(getOperationId(requests[0]), 'food-delete-operation-1');
});

test('deleteMetric sends the caller operation ID', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.deleteMetric(24, 'metric-delete-operation-1');

    assert.equal(requests[0]?.url, 'https://calibrate.example/api/v1/metrics/24');
    assert.equal(requests[0]?.init.method, 'DELETE');
    assert.equal(getOperationId(requests[0]), 'metric-delete-operation-1');
});

test('operation ID header is omitted when callers do not provide one', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.addMetric({ weight: 82.5, date: '2026-07-11' });

    assert.equal(getOperationId(requests[0]), null);
});
