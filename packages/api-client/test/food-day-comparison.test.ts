/** @file Regression coverage for food day comparison: normalizes legacy completion without inventing comparison data and preserves additive range values. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CalibrateApiClient } from '../src/client.ts';

test('normalizes legacy completion without inventing comparison data and preserves additive range values', async () => {
    const comparison = { consumed_kcal: 0, target_kcal: 2000, maintenance_kcal: 2500, captured_at: '2026-07-01T12:00:00Z' };
    const rows = [
        { date: '2026-07-01', is_complete: true, completed_at: null },
        { date: '2026-07-02', status: 'COMPLETE', is_complete: true, completed_at: null, calorie_comparison: comparison },
        { date: '2026-07-03', status: 'COMPLETE', is_complete: true, completed_at: null, calorie_comparison: null }
    ];
    const client = new CalibrateApiClient({ baseUrl: 'https://calibrate.example', fetchImpl: async () => new Response(JSON.stringify({ start_date: '2026-07-01', end_date: '2026-07-03', days: rows }), { status: 200 }) });
    const result = await client.getFoodDays('2026-07-01', '2026-07-03');
    assert.equal(result.days[0].status, 'COMPLETE');
    assert.equal(result.days[0].calorie_comparison, undefined);
    assert.deepEqual(result.days[1].calorie_comparison, comparison);
    assert.equal(result.days[2].calorie_comparison, null);
});
