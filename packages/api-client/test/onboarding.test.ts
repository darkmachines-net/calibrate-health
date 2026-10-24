/** @file Regression coverage for onboarding: atomic completion sends one complete payload and a stable operation ID. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

type CapturedRequest = { url: string; init: RequestInit };

const COMPLETE_DATA = {
    weight_unit: 'KG' as const,
    height_unit: 'CM' as const,
    timezone: 'America/Los_Angeles',
    date_of_birth: '1990-04-12',
    sex: 'FEMALE' as const,
    height_mm: 1680,
    activity_level: 'MODERATE' as const,
    current_weight_grams: 79400,
    target_weight_grams: 76000,
    daily_deficit: 500
};

const USER = {
    id: 1,
    email: 'person@example.com',
    created_at: '2026-08-08T08:00:00.000Z',
    weight_unit: 'KG' as const,
    height_unit: 'CM' as const,
    timezone: 'America/Los_Angeles',
    language: 'en',
    reminder_log_weight_enabled: true,
    reminder_log_food_enabled: true,
    haptics_enabled: true,
    date_of_birth: '1990-04-12',
    sex: 'FEMALE' as const,
    height_mm: 1680,
    activity_level: 'MODERATE' as const,
    profile_image_url: null,
    onboarding_completed_at: '2026-08-09T08:30:00.000Z'
};

const requestJson = (request: CapturedRequest): unknown => JSON.parse(String(request.init.body));

test('atomic completion sends one complete payload and a stable operation ID', async () => {
    const requests: CapturedRequest[] = [];
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        getAccessToken: () => 'access-token',
        fetchImpl: (async (input, init) => {
            requests.push({ url: String(input), init: init ?? {} });
            return Response.json({
                receipt: {
                    operation_id: 'onboarding-operation-1',
                    completed_at: '2026-08-09T08:30:00.000Z',
                    goal_id: 41,
                    metric_id: 52,
                    sync_cursor: '73'
                },
                user: USER
            });
        }) as typeof fetch
    });

    const result = await client.completeOnboarding(
        { data: COMPLETE_DATA },
        'onboarding-operation-1'
    );

    assert.equal(requests[0]?.url, 'https://calibrate.example/api/v1/onboarding/complete');
    assert.equal(requests[0]?.init.method, 'POST');
    assert.equal(
        new Headers(requests[0]?.init.headers).get('x-client-operation-id'),
        'onboarding-operation-1'
    );
    assert.deepEqual(requestJson(requests[0]!), { data: COMPLETE_DATA });
    assert.equal(result.receipt.operation_id, 'onboarding-operation-1');
    assert.equal(result.user.onboarding_completed_at, '2026-08-09T08:30:00.000Z');
});