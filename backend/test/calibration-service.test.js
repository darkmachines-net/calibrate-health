/** @file Legacy-client coverage: retired suggestions cannot change targets, while accepted future changes remain visible. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadService(planning, mutationDatabase) {
    const paths = ['../src/config/database', '../src/services/caloriePlanning', '../src/services/clientOperations', '../src/services/dailyCaloriePlans', '../src/services/caloriePlanningLock'].map(require.resolve);
    const cached = paths.map(path => require.cache[path]);
    const exports = [
        { $transaction: async fn => fn({}), user: { findUnique: async () => ({ timezone: 'America/Los_Angeles' }) } },
        { buildStoredCaloriePlanningSnapshot: async () => planning },
        { executeIdempotentMutation: async options => {
            if (!mutationDatabase) throw new Error('Unexpected target mutation');
            return options.mutate(mutationDatabase, 'test-operation');
        }, recordSyncChange: async () => undefined },
        { observeCurrentCaloriePlan: async () => undefined }, { lockCaloriePlanningInputs: async () => undefined }
    ];
    paths.forEach((path, index) => { const stub = new Module(path); stub.exports = exports[index]; stub.loaded = true; require.cache[path] = stub; });
    delete require.cache[require.resolve('../src/services/calibration')];
    const service = require('../src/services/calibration');
    paths.forEach((path, index) => { if (cached[index]) require.cache[path] = cached[index]; else delete require.cache[path]; });
    return service;
}

function planning() {
    return { user: { timezone: 'America/Los_Angeles', weight_unit: 'KG' }, goal: { daily_deficit: 500 },
        evaluation: { status: 'available', reasonCode: null, tdee: 2400, minimumDailyCalorieTarget: 1500 }, nextRevision: null };
}

test('legacy status never reads tracking or materializes recommendations', async () => {
    const service = loadService(planning());
    const result = await service.buildCalibrationStatus(17, new Date('2026-11-08T07:30:00Z'));
    assert.equal(result.evaluation.asOfDate, '2026-11-06');
    assert.equal(result.recommendation, null);
    assert.equal(result.evaluation.recommendation, null);
    assert.equal(result.evaluation.assessment.state, 'waiting');
});

test('all new applications are rejected without starting a write', async () => {
    const service = loadService(planning());
    await assert.rejects(service.applyCalibrationRecommendation({ userId: 17, recommendationId: 99 }), /retired/);
});

test('an approved future revision remains visible and unsafe budgets stay hidden', async () => {
    const input = planning();
    input.nextRevision = { recommendation_id: 9, target_adjustment_kcal: -100, effective_local_date: new Date('2026-11-09'), calorie_plan_review_status: 'CLEAR' };
    const service = loadService(input);
    const result = await service.buildCalibrationStatus(17, new Date('2026-11-08T12:00:00Z'));
    assert.equal(result.scheduledChange.dailyCalorieBudgetKcal, 1800);
    input.evaluation.status = 'requires_review';
    assert.equal((await service.buildCalibrationStatus(17)).scheduledChange.dailyCalorieBudgetKcal, null);
});

test('undo remains owner-scoped and retires the canceled recommendation', async () => {
    let deleted = false;
    let update;
    let effective = new Date('2026-11-09');
    const tx = {
        caloriePlanRevision: { delete: async () => { deleted = true; } },
        calibrationRecommendation: {
            findFirst: async ({ where }) => {
                assert.equal(where.user_id, 17);
                assert.equal(where.id, 9);
                return { id: 9, plan_revision: { id: 42, effective_local_date: effective } };
            },
            update: async ({ data }) => { update = data; }
        }
    };
    const service = loadService(planning(), tx);
    const options = { userId: 17, recommendationId: 9, now: new Date('2026-11-08T12:00:00Z') };
    await service.cancelScheduledCalibrationChange(options);
    assert.equal(deleted, true);
    assert.equal(update.status, 'STALE');
    deleted = false;
    effective = new Date('2026-11-08');
    await assert.rejects(service.cancelScheduledCalibrationChange(options), /already started/);
    assert.equal(deleted, false);
});
