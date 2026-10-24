/** @file Regression coverage for watch: watch snapshot uses the versioned restricted surface. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

type CapturedRequest = { url: string; init: RequestInit };

const createClient = (requests: CapturedRequest[]) => new CalibrateApiClient({
    baseUrl: 'https://self-hosted.example',
    getAccessToken: () => 'wear-access-token',
    fetchImpl: (async (input, init) => {
        requests.push({ url: String(input), init: init ?? {} });
        return new Response(JSON.stringify({ revision: 'r1' }), { status: 200 });
    }) as typeof fetch
});

test('watch snapshot uses the versioned restricted surface', async () => {
    const requests: CapturedRequest[] = [];
    const result = await createClient(requests).getWatchSnapshot();
    assert.equal(requests[0]?.url, 'https://self-hosted.example/api/v1/watch');
    assert.equal(new Headers(requests[0]?.init.headers).get('authorization'), 'Bearer wear-access-token');
    assert.equal(result.notModified, false);
    assert.deepEqual(result.body, { revision: 'r1' });
});

test('watch snapshot contract exposes unit and revisions needed for offline actions', () => {
    const snapshot: import('../src/types.ts').WatchSnapshot = {
        server_time: '2026-07-11T20:00:00.000Z',
        timezone: 'America/Los_Angeles',
        local_date: '2026-07-11',
        weight_unit: 'LB',
        revision: '0123456789abcdef01234567',
        calories: { consumed: 1200, target: 2000, remaining: 800, missing: [] },
        food_day: {
            status: 'COMPLETE',
            source: 'USER',
            is_representative: true,
            is_complete: true,
            completed_at: '2026-07-11T19:00:00.000Z',
            revision: '111111111111111111111111'
        },
        weight: {
            today_grams: 80000,
            today_revision: '222222222222222222222222',
            latest_grams: 80000,
            latest_revision: '222222222222222222222222',
            latest_date: '2026-07-11'
        },
        goal: {
            start_weight_grams: 90000,
            target_weight_grams: 75000,
            current_weight_grams: 80000,
            daily_deficit: 500,
            progress_percent: 66.7,
            remaining_weight_grams: 5000,
            is_complete: false
        },
        quick_add: [],
        reminders: [{
            id: 51,
            type: 'food',
            local_date: '2026-07-11',
            created_at: '2026-07-11T17:00:00.000Z'
        }],
        undo_candidate: { food_log_id: 88, name: 'Oats', calories: 300, created_at: '2026-07-11T15:00:00.000Z' }
    };

    assert.equal(snapshot.weight_unit, 'LB');
    assert.equal(snapshot.weight.latest_revision, snapshot.weight.today_revision);
    assert.equal(snapshot.goal?.remaining_weight_grams, 5000);
    assert.equal(snapshot.reminders[0]?.type, 'food');
    assert.equal('date' in snapshot.food_day, false);
});

test('watch snapshot sends If-None-Match and returns 304 metadata without throwing', async () => {
    const requests: CapturedRequest[] = [];
    const client = new CalibrateApiClient({
        baseUrl: 'https://self-hosted.example',
        getAccessToken: () => 'wear-access-token',
        fetchImpl: (async (input, init) => {
            requests.push({ url: String(input), init: init ?? {} });
            return new Response(null, { status: 304, headers: { etag: 'W/"watch-r1"' } });
        }) as typeof fetch
    });
    const result = await client.getWatchSnapshot('W/"watch-r1"');
    assert.equal(new Headers(requests[0]?.init.headers).get('if-none-match'), 'W/"watch-r1"');
    assert.deepEqual(result, { body: null, etag: 'W/"watch-r1"', notModified: true });
});

test('watch mutation always carries its client operation id', async () => {
    const requests: CapturedRequest[] = [];
    const payload = {
        type: 'metric.upsert' as const,
        payload: { local_date: '2026-07-11', weight_grams: 81234, expected_revision: null }
    };
    await createClient(requests).executeWatchMutation(payload, 'watch-operation-001');
    assert.equal(requests[0]?.url, 'https://self-hosted.example/api/v1/watch/mutations');
    assert.equal(new Headers(requests[0]?.init.headers).get('x-client-operation-id'), 'watch-operation-001');
    assert.equal(requests[0]?.init.body, JSON.stringify(payload));
});
