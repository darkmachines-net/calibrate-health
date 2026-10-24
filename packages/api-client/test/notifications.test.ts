/** @file Regression coverage for notifications: notification methods preserve legacy reads and send additive paging/read-all requests. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

test('notification methods preserve legacy reads and send additive paging/read-all requests', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: (async (input, init) => {
            const url = String(input);
            requests.push({ url, method: init?.method ?? 'GET' });

            if (url.endsWith('/read-all')) {
                return new Response(JSON.stringify({ ok: true, updated_count: 3 }), { status: 200 });
            }
            if (url.includes('?')) {
                return new Response(JSON.stringify({
                    notifications: [],
                    unread_count: 2,
                    next_cursor: 'next'
                }), { status: 200 });
            }
            return new Response(JSON.stringify({ notifications: [], unread_count: 2 }), { status: 200 });
        }) as typeof fetch
    });

    assert.deepEqual(await client.getInAppNotifications(), {
        notifications: [],
        unread_count: 2
    });
    assert.deepEqual(await client.getInAppNotifications({
        view: 'history',
        limit: 20,
        cursor: 'cursor-2'
    }), {
        notifications: [],
        unread_count: 2,
        next_cursor: 'next'
    });
    assert.deepEqual(await client.markAllInAppNotificationsRead(), {
        ok: true,
        updated_count: 3
    });

    assert.deepEqual(requests, [
        {
            url: 'https://calibrate.example/api/v1/notifications/in-app',
            method: 'GET'
        },
        {
            url: 'https://calibrate.example/api/v1/notifications/in-app?view=history&limit=20&cursor=cursor-2',
            method: 'GET'
        },
        {
            url: 'https://calibrate.example/api/v1/notifications/in-app/read-all',
            method: 'PATCH'
        }
    ]);
});
