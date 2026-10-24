/** @file Regression coverage for activity: activity day query uses versioned date parameters. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

type CapturedRequest = { url: string; init: RequestInit };

function createClient(requests: CapturedRequest[]): CalibrateApiClient {
    return new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input, init) => {
            requests.push({ url: String(input), init: init ?? {} });
            return new Response('{}', { status: 200 });
        }) as typeof fetch
    });
}

test('activity day query uses versioned date parameters', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.getActivityDays({ start: '2026-07-01', end: '2026-07-11' });

    assert.equal(
        requests[0]?.url,
        'https://calibrate.example/api/v1/activity/days?start=2026-07-01&end=2026-07-11'
    );
    assert.equal(requests[0]?.init.method, undefined);
});

test('Health Connect sync carries its operation id and atomic checkpoint payload', async () => {
    const requests: CapturedRequest[] = [];
    const client = createClient(requests);

    await client.syncHealthConnect({
        sync_mode: 'incremental',
        record_type: 'STEPS',
        previous_changes_token: null,
        next_changes_token: 'next-token',
        upserts: [{
            record_id: 'health-record-1',
            data_origin: 'com.sec.android.app.shealth',
            source_updated_at: '2026-07-11T19:00:00.000Z',
            start_time: '2026-07-11T18:00:00.000Z',
            end_time: '2026-07-11T19:00:00.000Z',
            count: 1500
        }]
    }, 'health-sync-operation-1');

    assert.equal(requests[0]?.url, 'https://calibrate.example/api/v1/activity/health-connect/sync');
    assert.equal(requests[0]?.init.method, 'POST');
    assert.equal(
        new Headers(requests[0]?.init.headers).get('x-client-operation-id'),
        'health-sync-operation-1'
    );
    assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
        sync_mode: 'incremental',
        record_type: 'STEPS',
        previous_changes_token: null,
        next_changes_token: 'next-token',
        upserts: [{
            record_id: 'health-record-1',
            data_origin: 'com.sec.android.app.shealth',
            source_updated_at: '2026-07-11T19:00:00.000Z',
            start_time: '2026-07-11T18:00:00.000Z',
            end_time: '2026-07-11T19:00:00.000Z',
            count: 1500
        }]
    });
});
