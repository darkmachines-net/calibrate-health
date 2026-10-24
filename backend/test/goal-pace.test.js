/** @file Regression coverage for goal pace: adjustment preserves identity, baseline, target intent and 33% progress; replay and unchanged save are harmless. */

const test = require('node:test'), assert = require('node:assert/strict'), Module = require('node:module');
const { Prisma } = require('@prisma/client');
function fixture() {
    const user = { id: 7, timezone: 'America/Los_Angeles', date_of_birth: new Date('1990-01-01Z'), sex: 'MALE', height_mm: 1800, activity_level: 'MODERATE', weight_unit: 'KG', height_unit: 'CM' };
    const goal = { id: 4, user_id: 7, created_at: new Date('2025-01-01Z'), start_weight_grams: 90000, target_weight_grams: 75000, target_date: new Date('2027-02-01Z'), daily_deficit: 500, calorie_plan_review_status: 'CLEAR', calorie_plan_review_reason: null };
    const revisions = [], events = [], receipts = new Map();
    let stale = 0, creates = 0, weight = 85000;
    const matching = ({ where, orderBy }) => revisions.filter(r => r.source_goal_id === where.source_goal_id && (!where.configured_daily_deficit || r.configured_daily_deficit != null) && (!where.effective_local_date?.lte || r.effective_local_date <= where.effective_local_date.lte) && (!where.effective_local_date?.gt || r.effective_local_date > where.effective_local_date.gt)).sort((a, b) => orderBy[0].effective_local_date === 'desc' ? b.effective_local_date - a.effective_local_date || b.id - a.id : a.effective_local_date - b.effective_local_date || a.id - b.id);
    const db = { $executeRaw: async () => 1, user: { findUnique: async () => ({ ...user }) }, goal: { findFirst: async () => ({ ...goal }), create: async ({ data }) => { creates++; return { ...data, id: 10, created_at: new Date() }; } }, bodyMetric: { findFirst: async () => weight === null ? null : { weight_grams: weight } }, caloriePlanRevision: { findFirst: async (args) => matching(args)[0] ?? null, findMany: async (args) => matching(args), create: async ({ data }) => { const r = { id: revisions.length + 1, recommendation_id: null, configured_daily_deficit: null, calorie_plan_review_status: 'CLEAR', calorie_plan_review_reason: null, ...data }; revisions.push(r); return r; } }, calibrationRecommendation: { updateMany: async () => { stale++; return { count: 1 }; } }, syncChange: { create: async ({ data }) => { events.push(data); return { id: 1n }; } }, clientOperation: { create: async ({ data }) => { if (receipts.has(data.operation_id))
                throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' }); receipts.set(data.operation_id, { ...data, response_status: null, completed_at: null }); }, update: async ({ where, data }) => Object.assign(receipts.get(where.user_id_operation_id.operation_id), data), findUnique: async ({ where }) => receipts.get(where.user_id_operation_id.operation_id) }, $transaction: async (callback) => callback(db) };
    const dbPath = require.resolve('../src/config/database'), stub = new Module(dbPath);
    db.dailyCaloriePlan = require('./helpers/dailyCaloriePlanStore')();
    stub.exports = db;
    stub.loaded = true;
    require.cache[dbPath] = stub;
    for (const file of ['caloriePlanning', 'goalPace', 'clientOperations'])
        delete require.cache[require.resolve('../src/services/' + file)];
    delete require.cache[require.resolve('../src/routes/goals')];
    const router = require('../src/routes/goals').default, snapshot = require('../src/services/caloriePlanning').buildStoredCaloriePlanningSnapshot;
    async function call(method, path, body, operation = 'operation-001') {
        const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, set() { return this; }, json(body) { this.body = body; return this; } };
        await router.stack.find(l => l.route?.path === path && l.route.methods[method]).route.stack[0].handle({ user, params: { id: String(goal.id) }, body, headers: { 'x-client-operation-id': operation } }, res);
        return res;
    }
    return { user, goal, revisions, events, db, snapshot, call, setWeight: v => { weight = v; }, counts: () => ({ stale, creates }) };
}
test('adjustment preserves identity, baseline, target intent and 33% progress; replay and unchanged save are harmless', async () => {
    const f = fixture(), original = JSON.stringify(f.goal), before = await f.call('get', '/pace-options');
    const payload = { daily_deficit: 250, expected_plan_version: before.body.expected_plan_version };
    const saved = await f.call('patch', '/:id/pace', payload);
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.id, 4);
    assert.equal(saved.body.start_weight, 90);
    assert.equal(saved.body.target_weight, 75);
    assert.equal(saved.body.daily_deficit, 250);
    assert.equal(saved.body.created_at, '2025-01-01T00:00:00.000Z');
    assert.equal(saved.body.target_date, '2027-02-01T00:00:00.000Z');
    assert.equal(Math.round((90 - 85) / (90 - 75) * 100), 33);
    assert.ok(saved.body.projection.projected_end_date > before.body.goal.projection.projected_end_date);
    assert.deepEqual((await f.call('patch', '/:id/pace', payload)).body, saved.body);
    assert.equal(JSON.stringify(f.goal), original);
    assert.equal(f.revisions.length, 1);
    assert.deepEqual(f.counts(), { stale: 1, creates: 0 });
    assert.equal(f.events.length, 2);
    assert.equal((await f.call('get', '/')).body.daily_deficit, 250);
    const same = await f.call('get', '/pace-options');
    assert.equal((await f.call('patch', '/:id/pace', { daily_deficit: 250, expected_plan_version: same.body.expected_plan_version }, 'operation-002')).statusCode, 200);
    assert.equal(f.revisions.length, 1);
    const next = await f.call('patch', '/:id/pace', { daily_deficit: 500, expected_plan_version: same.body.expected_plan_version }, 'operation-003');
    assert.equal(next.body.start_weight, 90);
    assert.equal(f.revisions.length, 2);
});
test('local year boundary and same-day ordering preserve earlier pace; scheduled calibration inherits new pace', async () => {
    const f = fixture();
    f.revisions.push({ id: 1, source_goal_id: 4, configured_daily_deficit: 250, target_adjustment_kcal: 0, effective_local_date: new Date('2026-01-01Z'), calorie_plan_review_status: 'CLEAR' }, { id: 2, source_goal_id: 4, configured_daily_deficit: 750, target_adjustment_kcal: 0, effective_local_date: new Date('2026-01-01Z'), calorie_plan_review_status: 'CLEAR' }, { id: 3, source_goal_id: 4, configured_daily_deficit: null, target_adjustment_kcal: 100, effective_local_date: new Date('2026-01-02Z'), calorie_plan_review_status: 'CLEAR' });
    const prior = await f.snapshot(f.db, 7, new Date('2026-01-01T07:59:59Z')), day = await f.snapshot(f.db, 7, new Date('2026-01-01T08:00:00Z')), later = await f.snapshot(f.db, 7, new Date('2026-01-02T08:00:00Z'));
    assert.equal(prior.localToday, '2025-12-31');
    assert.equal(prior.goal.daily_deficit, 500);
    assert.equal(day.goal.daily_deficit, 750);
    assert.equal(later.goal.daily_deficit, 750);
    assert.equal(later.evaluation.targetAdjustment, 100);
});
test('stale editor, changed profile, another goal and reused operation never overwrite a newer plan', async () => {
    const f = fixture(), preview = await f.call('get', '/pace-options'), body = { daily_deficit: 250, expected_plan_version: preview.body.expected_plan_version };
    f.user.height_mm = 1810;
    assert.equal((await f.call('patch', '/:id/pace', body)).statusCode, 409);
    assert.equal(f.revisions.length, 0);
    f.goal.id = 6;
    assert.equal((await f.call('patch', '/:id/pace', body, 'operation-002')).statusCode, 409);
    assert.equal((await f.call('patch', '/:id/pace', { ...body, daily_deficit: 750 })).body.code, 'OPERATION_ID_REUSED');
});
test('missing weight, unsafe/review plan, unsupported values and direction changes have no partial domain writes', async () => {
    for (const kind of ['weight', 'review', 'unsupported', 'direction', 'floor']) {
        const f = fixture();
        if (kind === 'weight')
            f.setWeight(null);
        if (kind === 'review')
            f.goal.calorie_plan_review_status = 'REQUIRES_REVIEW';
        if (kind === 'floor')
            f.user.activity_level = 'SEDENTARY';
        const p = await f.call('get', '/pace-options');
        const deficit = kind === 'unsupported' ? 123 : kind === 'direction' ? -250 : kind === 'floor' ? 1000 : 250;
        const r = await f.call('patch', '/:id/pace', { daily_deficit: deficit, expected_plan_version: p.body.expected_plan_version });
        assert.equal(r.statusCode, 400, kind);
        assert.equal(f.revisions.length, 0);
        assert.equal(f.events.length, 0);
    }
});
test('gain adjustment preserves negative direction; intentional new goal still creates a fresh identity', async () => {
    const f = fixture();
    f.goal.start_weight_grams = 70000;
    f.goal.target_weight_grams = 90000;
    f.goal.daily_deficit = -500;
    const p = await f.call('get', '/pace-options');
    const r = await f.call('patch', '/:id/pace', { daily_deficit: -250, expected_plan_version: p.body.expected_plan_version });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.daily_deficit, -250);
    assert.equal(r.body.start_weight, 70);
    const created = await f.call('post', '/', { start_weight: 85, target_weight: 75, daily_deficit: 250 }, 'new-goal-operation');
    assert.equal(created.statusCode, 200);
    assert.equal(created.body.id, 10);
    assert.equal(created.body.start_weight, 85);
    assert.equal(f.counts().creates, 1);
});
test('effective and scheduled corrections are retained; unsafe future combination is disabled', async () => {
    const f = fixture();
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 2);
    tomorrow.setUTCHours(0, 0, 0, 0);
    f.revisions.push({ id: 1, source_goal_id: 4, configured_daily_deficit: null, target_adjustment_kcal: 100,
        effective_local_date: new Date('2025-02-01Z'), calorie_plan_review_status: 'CLEAR' }, { id: 2, source_goal_id: 4, configured_daily_deficit: null, target_adjustment_kcal: -400,
        effective_local_date: tomorrow, calorie_plan_review_status: 'CLEAR' });
    const oldHistory = JSON.stringify(f.revisions);
    const preview = await f.call('get', '/pace-options');
    assert.equal(preview.body.planOptions.find(option => option.dailyDeficit === 750).available, false);
    const saved = await f.call('patch', '/:id/pace', { daily_deficit: 250, expected_plan_version: preview.body.expected_plan_version });
    assert.equal(saved.statusCode, 200);
    assert.equal(JSON.stringify(f.revisions.slice(0, 2)), oldHistory);
    const later = await f.snapshot(f.db, 7, new Date(tomorrow.getTime() + 12 * 3600000));
    assert.equal(later.goal.daily_deficit, 250);
    assert.equal(later.evaluation.targetAdjustment, -400);
});
test('existing completion provenance survives manual pace and recompletion; a new day captures the new plan', async () => {
    const f = fixture();
    delete require.cache[require.resolve('../src/services/foodDayComparison')];
    const { captureFoodDayComparison, foodDayCalorieComparison } = require('../src/services/foodDayComparison');
    const now = new Date();
    const snapshot = await f.snapshot(f.db, 7, now);
    const day = { id: 1, user_id: 7, status: 'COMPLETE', local_date: new Date(snapshot.localToday + 'T00:00:00Z') };
    f.db.foodLogDay = { update: async ({ data }) => Object.assign(day, data) };
    await captureFoodDayComparison(f.db, day, now);
    const comparison = foodDayCalorieComparison(day, 2000);
    const preview = await f.call('get', '/pace-options');
    await f.call('patch', '/:id/pace', { daily_deficit: 250, expected_plan_version: preview.body.expected_plan_version });
    day.status = 'OPEN';
    await captureFoodDayComparison(f.db, day, now);
    day.status = 'COMPLETE';
    await captureFoodDayComparison(f.db, day, now);
    assert.deepEqual(foodDayCalorieComparison(day, 2000), comparison);
    const plan = await f.snapshot(f.db, 7, now);
    assert.equal(plan.evaluation.dailyCalorieTarget, comparison.target_kcal + 250);
    assert.equal(plan.evaluation.tdee, snapshot.evaluation.tdee);
});

test('new-goal serialization conflict is recoverable and retry keeps its operation ID', async () => {
    const f = fixture();
    const originalTransaction = f.db.$transaction;
    f.db.$transaction = async () => { throw new Prisma.PrismaClientKnownRequestError('serialization conflict', { code: 'P2034', clientVersion: 'test' }); };
    const payload = { start_weight: 85, target_weight: 75, daily_deficit: 250 };
    const conflict = await f.call('post', '/', payload, 'new-goal-retry');
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.code, 'GOAL_PLAN_CHANGED');
    assert.equal(conflict.body.retryable, true);
    assert.equal(f.counts().creates, 0);
    f.db.$transaction = originalTransaction;
    const saved = await f.call('post', '/', payload, 'new-goal-retry');
    assert.equal(saved.statusCode, 200);
    assert.deepEqual((await f.call('post', '/', payload, 'new-goal-retry')).body, saved.body);
    assert.equal(f.counts().creates, 1);
});

test('missing and non-object pace request bodies return structured 400 before mutation', async () => {
    const f = fixture();
    for (const body of [undefined, null, '', [], {}]) {
        const result = await f.call('patch', '/:id/pace', body);
        assert.equal(result.statusCode, 400);
        assert.equal(result.body.code, 'CALORIE_PLAN_OPTION_UNAVAILABLE');
        assert.equal(result.body.retryable, false);
    }
    assert.equal(f.revisions.length, 0);
    assert.equal(f.events.length, 0);
});

test('raw SQL serialization and deadlock conflicts return recoverable plan conflicts without a revision', async () => {
    for (const meta of [{ code: '40001' }, { code: '40P01' },
        { driverAdapterError: { cause: { originalCode: '40001', kind: 'TransactionWriteConflict' } } },
        { driverAdapterError: { cause: { originalCode: '40P01', kind: 'postgres' } } }]) {
        const f = fixture();
        const preview = await f.call('get', '/pace-options');
        f.db.$executeRaw = async () => { throw new Prisma.PrismaClientKnownRequestError('concurrent writer', {
            code: 'P2010', clientVersion: 'test', meta
        }); };
        const result = await f.call('patch', '/:id/pace', { daily_deficit: 250, expected_plan_version: preview.body.expected_plan_version });
        assert.equal(result.statusCode, 409);
        assert.equal(result.body.code, 'GOAL_PLAN_CHANGED');
        assert.equal(f.revisions.length, 0);
        assert.equal(f.events.length, 0);
    }
});
