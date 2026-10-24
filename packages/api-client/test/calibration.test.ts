/** @file Regression coverage for calibration: uses the versioned calibration status, apply, and cancel routes. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

test('uses the versioned calibration status, apply, and cancel routes', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new CalibrateApiClient({
        baseUrl: 'https://calibrate.example',
        fetchImpl: async (url, init) => {
            requests.push({ url: String(url), init });
            const body = String(url).endsWith('/status')
                ? {
                    generatedAt: '2026-07-31T00:00:00.000Z',
                    inputFingerprint: null,
                    evaluation: {},
                    recommendation: null,
                    scheduledChange: null
                }
                : {
                    recommendationId: 7,
                    targetAdjustmentKcal: -150,
                    dailyCalorieBudgetKcal: 1750,
                    effectiveLocalDate: '2026-08-01'
                };
            return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        }
    });

    await client.getCalibrationStatus();
    await client.applyCalibrationRecommendation(7, 'calibration-op-0001');
    await client.cancelCalibrationRecommendation(7, 'calibration-op-0002');

    assert.equal(requests[0]?.url, 'https://calibrate.example/api/v1/calibration/status');
    assert.equal(requests[1]?.url, 'https://calibrate.example/api/v1/calibration/recommendations/7/apply');
    assert.equal(new Headers(requests[1]?.init?.headers).get('x-client-operation-id'), 'calibration-op-0001');
    assert.equal(requests[2]?.url, 'https://calibrate.example/api/v1/calibration/recommendations/7/cancel');
    assert.equal(new Headers(requests[2]?.init?.headers).get('x-client-operation-id'), 'calibration-op-0002');
});
