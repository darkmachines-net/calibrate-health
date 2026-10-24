#!/usr/bin/env node
/** @file Exercises goal-pace persistence and idempotency against an isolated PostgreSQL smoke-test schema. */

/** Exercise goal continuity and concurrent writes in a disposable PostgreSQL schema. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { databaseUrlForSchema, migrateDeploy } from './postgres-populated-upgrade-smoke.mjs';
import { goalPaceFixtureDates } from './postgres-goal-pace-fixtures.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.join(root, 'backend');
const backendRequire = createRequire(path.join(backend, 'package.json'));
const schema = 'calibrate_upgrade_smoke_goal_pace_' + crypto.randomBytes(8).toString('hex');
const rawUrl = process.env.DATABASE_URL;
assert.ok(rawUrl, 'DATABASE_URL is required; only a newly allocated smoke schema is modified.');
const { Client } = backendRequire('pg');
const admin = new Client({ connectionString: rawUrl });
let disconnectDatabase;
await admin.connect();
try {
    assert.match(schema, /^calibrate_upgrade_smoke_goal_pace_[a-f0-9]+$/);
    await admin.query('CREATE SCHEMA "' + schema + '"');
    const url = databaseUrlForSchema(rawUrl, schema);
    migrateDeploy(url, path.join(backend, 'prisma/schema.prisma'));
    process.env.DATABASE_URL = url;
    backendRequire('ts-node').register({ project: path.join(backend, 'tsconfig.json'), transpileOnly: true, compilerOptions: { module: 'commonjs' } });
    const database = backendRequire('./src/config/database');
    disconnectDatabase = database.disconnectDatabase;
    const db = database.default;
    const router = backendRequire('./src/routes/goals').default;
    const metricsRouter = backendRequire('./src/routes/metrics').default;
    const userRouter = backendRequire('./src/routes/user').default;
    const planningLock = backendRequire('./src/services/caloriePlanningLock');
    const user = await db.user.create({ data: { email: 'pace-smoke@synthetic.invalid', password_hash: 'synthetic-only', timezone: 'UTC',
            date_of_birth: new Date('1990-01-01Z'), sex: 'MALE', height_mm: 1800, activity_level: 'MODERATE', weight_unit: 'KG', height_unit: 'CM' } });
    const goal = await db.goal.create({ data: { user_id: user.id, start_weight_grams: 90000, target_weight_grams: 75000,
            daily_deficit: 500, created_at: new Date('2025-01-01Z'), target_date: new Date('2027-02-01Z') } });
    const dates = goalPaceFixtureDates(new Date());
    const { today } = dates;
    await db.bodyMetric.create({ data: { user_id: user.id, date: today, weight_grams: 85000 } });
    const day = await db.foodLogDay.create({ data: { user_id: user.id, local_date: today, status: 'COMPLETE', origin: 'USER',
            comparison_target_kcal: 2000, comparison_maintenance_kcal: 2500, comparison_captured_at: new Date() } });
    /** Invoke real route handlers with the synthetic authentication and receipt context. */
    async function call(method, routePath, body = {}, operation = crypto.randomUUID(), targetRouter = router, goalId = goal.id) {
        const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, set() { return this; }, json(data) { this.body = data; return this; } };
        const handler = targetRouter.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method]).route.stack[0].handle;
        await handler({ user, params: { id: String(goalId) }, body, headers: { 'x-client-operation-id': operation } }, res);
        return res;
    }
    const preview = await call('get', '/pace-options');
    const payload = { daily_deficit: 250, expected_plan_version: preview.body.expected_plan_version };
    const operation = crypto.randomUUID();
    const first = await call('patch', '/:id/pace', payload, operation);
    assert.equal(first.statusCode, 200);
    assert.deepEqual((await call('patch', '/:id/pace', payload, operation)).body, first.body);
    assert.equal(await db.goal.count({ where: { user_id: user.id } }), 1);
    assert.equal(await db.caloriePlanRevision.count({ where: { user_id: user.id } }), 1);
    assert.deepEqual(await db.goal.findUnique({ where: { id: goal.id } }), goal);
    assert.deepEqual(await db.foodLogDay.findUnique({ where: { id: day.id } }), day);
    assert.equal(first.body.start_weight, 90);
    assert.equal(first.body.daily_deficit, 250);
    const next = await call('get', '/pace-options');
    const race = await Promise.all([500, 750].map(daily_deficit => call('patch', '/:id/pace', {
        daily_deficit, expected_plan_version: next.body.expected_plan_version
    })));
    assert.deepEqual(race.map(result => result.statusCode).sort(), [200, 409]);
    assert.equal(await db.caloriePlanRevision.count({ where: { user_id: user.id } }), 2);
    // Hold each real input writer after its shared guard, then start a pace save
    // with the prior preview. Release the writer only after pace reaches its guard.
    const originalLock = planningLock.lockCaloriePlanningInputs;
    for (const kind of ['weight', 'timezone']) {
        const prior = await call('get', '/pace-options');
        const revisionCount = await db.caloriePlanRevision.count({ where: { user_id: user.id } });
        let releaseWriter, writerLocked, paceEntered;
        const release = new Promise(resolve => { releaseWriter = resolve; });
        const locked = new Promise(resolve => { writerLocked = resolve; });
        const entered = new Promise(resolve => { paceEntered = resolve; });
        let calls = 0;
        planningLock.lockCaloriePlanningInputs = async (...args) => {
            const ordinal = ++calls;
            if (ordinal === 2) paceEntered();
            await originalLock(...args);
            if (ordinal === 1) { writerLocked(); await release; }
        };
        const writer = kind === 'weight'
            ? call('post', '/', { date: today.toISOString().slice(0, 10), weight: 84 }, crypto.randomUUID(), metricsRouter)
            : call('patch', '/profile', { timezone: 'Pacific/Kiritimati' }, crypto.randomUUID(), userRouter);
        try {
            await Promise.race([locked, writer.then(result => { throw new Error(kind + " writer ended before guard: " + JSON.stringify(result)); })]);
            const pace = call('patch', '/:id/pace', { daily_deficit: 250, expected_plan_version: prior.body.expected_plan_version });
            await Promise.race([entered, pace.then(result => { throw new Error("pace ended before guard: " + JSON.stringify(result)); })]);
            releaseWriter();
            assert.equal((await writer).statusCode, 200, kind + ' writer commits');
            const conflict = await pace;
            assert.equal(conflict.statusCode, 409, kind + ' change rejects the old pace snapshot');
            assert.equal(conflict.body.code, 'GOAL_PLAN_CHANGED');
            assert.equal(await db.caloriePlanRevision.count({ where: { user_id: user.id } }), revisionCount);
            console.log('[goal-pace-smoke] PASS: overlapping ' + kind + ' route commits; stale pace returns409 with no revision.');
        } finally {
            releaseWriter();
            planningLock.lockCaloriePlanningInputs = originalLock;
        }
    }
    const newGoal = await call('post', '/', { start_weight: 85, target_weight: 75, daily_deficit: 250 });
    assert.equal(newGoal.statusCode, 200);
    assert.notEqual(newGoal.body.id, goal.id);
    assert.equal((await call('patch', '/:id/pace', payload)).statusCode, 409);
    assert.equal(await db.bodyMetric.count({ where: { user_id: user.id } }), 1);
    // A RepeatableRead profile update waiting behind pace must fail recoverably,
    // then succeed in a fresh transaction. Its guard now precedes profile reads.
    const profilePreview = await call('get', '/pace-options');
    const unchangedTimezone = (await db.user.findUnique({ where: { id: user.id } })).timezone;
    let unlockPace, heldPace, pacePid;
    const unlock = new Promise(resolve => { unlockPace = resolve; });
    const held = new Promise(resolve => { heldPace = resolve; });
    let holdNextGuard = true;
    planningLock.lockCaloriePlanningInputs = async (...args) => {
        await originalLock(...args);
        if (holdNextGuard) {
            holdNextGuard = false;
            [{ pid: pacePid }] = await args[0].$queryRawUnsafe('SELECT pg_backend_pid() AS pid');
            heldPace();
            await unlock;
        }
    };
    const profileRacePace = call('patch', '/:id/pace', {
        daily_deficit: 500, expected_plan_version: profilePreview.body.expected_plan_version
    }, crypto.randomUUID(), router, newGoal.body.id);
    try {
        await Promise.race([held, profileRacePace.then(result => { throw new Error('pace ended before guard: ' + JSON.stringify(result)); })]);
        const profile = call('patch', '/profile', { timezone: 'UTC' }, crypto.randomUUID(), userRouter);
        let profileWaiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            const waiters = await admin.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pacePid]);
            if (waiters.rowCount) { profileWaiting = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        unlockPace();
        assert.equal((await profileRacePace).statusCode, 200);
        const rejectedProfile = await profile;
        assert.equal(profileWaiting, true, 'profile must actually wait on the held pace transaction');
        assert.equal(rejectedProfile.statusCode, 409);
        assert.equal(rejectedProfile.body.code, 'PROFILE_PLAN_CHANGED');
        assert.equal(rejectedProfile.body.retryable, true);
        assert.equal((await db.user.findUnique({ where: { id: user.id } })).timezone, unchangedTimezone);
    } finally {
        unlockPace();
        planningLock.lockCaloriePlanningInputs = originalLock;
    }
    assert.equal((await call('patch', '/profile', { timezone: 'UTC' }, crypto.randomUUID(), userRouter)).statusCode, 200);
    assert.equal((await db.user.findUnique({ where: { id: user.id } })).timezone, 'UTC');
    console.log('[goal-pace-smoke] PASS: pace-first profile conflict returns retryable409, rolls back, and succeeds on fresh retry.');

    // Reverse the order: an accepted pace must be visible to a later weight
    // writer's sticky safety check, even when its metric write already started.
    const currentPreview = await call('get', '/pace-options');
    assert.equal(currentPreview.body.planOptions.find(option => option.dailyDeficit === 750).available, true);
    let releasePace, paceLocked, weightEntered;
    const paceRelease = new Promise(resolve => { releasePace = resolve; });
    const paceLock = new Promise(resolve => { paceLocked = resolve; });
    const weightAtGuard = new Promise(resolve => { weightEntered = resolve; });
    let guardCalls = 0;
    planningLock.lockCaloriePlanningInputs = async (...args) => {
        const ordinal = ++guardCalls;
        if (ordinal === 2) weightEntered();
        await originalLock(...args);
        if (ordinal === 1) { paceLocked(); await paceRelease; }
    };
    const winningPace = call('patch', '/:id/pace', {
        daily_deficit: 750, expected_plan_version: currentPreview.body.expected_plan_version
    }, crypto.randomUUID(), router, newGoal.body.id);
    try {
        await Promise.race([paceLock, winningPace.then(result => { throw new Error('pace ended before guard: ' + JSON.stringify(result)); })]);
        const laterWeight = call('post', '/', { date: today.toISOString().slice(0, 10), weight: 25 }, crypto.randomUUID(), metricsRouter);
        await Promise.race([weightAtGuard, laterWeight.then(result => { throw new Error('weight ended before guard: ' + JSON.stringify(result)); })]);
        releasePace();
        assert.equal((await winningPace).statusCode, 200);
        assert.equal((await laterWeight).statusCode, 200);
        const currentGoal = await db.goal.findUnique({ where: { id: newGoal.body.id } });
        assert.equal(currentGoal.calorie_plan_review_status, 'REQUIRES_REVIEW');
        const currentRevision = await db.caloriePlanRevision.findFirst({ where: { source_goal_id: newGoal.body.id }, orderBy: { id: 'desc' } });
        assert.equal(currentRevision.configured_daily_deficit, 750);
        assert.equal(currentRevision.calorie_plan_review_status, 'REQUIRES_REVIEW');
        console.log('[goal-pace-smoke] PASS: pace-first overlap makes the later weight safety check review the accepted pace.');
    } finally {
        releasePace();
        planningLock.lockCaloriePlanningInputs = originalLock;
    }
    // A weight saved before goal creation and one saved behind an in-flight goal
    // creation must both establish the new goal's first-day baseline.
    const metricDate = today.toISOString().slice(0, 10);
    assert.equal((await call('post', '/', { date: metricDate, weight: 85 }, crypto.randomUUID(), metricsRouter)).statusCode, 200);
    const weightFirst = await call('post', '/', { start_weight: 85, target_weight: 75, daily_deficit: 250 });
    assert.equal(weightFirst.statusCode, 200);
    assert.equal(weightFirst.body.start_weight, 85);
    let releaseCreation, creationLocked, metricWaiting;
    const creationRelease = new Promise(resolve => { releaseCreation = resolve; });
    const creationGuard = new Promise(resolve => { creationLocked = resolve; });
    const metricGuard = new Promise(resolve => { metricWaiting = resolve; });
    let creationGuardCalls = 0;
    planningLock.lockCaloriePlanningInputs = async (...args) => {
        const ordinal = ++creationGuardCalls;
        if (ordinal === 2) metricWaiting();
        await originalLock(...args);
        if (ordinal === 1) { creationLocked(); await creationRelease; }
    };
    const creation = call('post', '/', { start_weight: 85, target_weight: 75, daily_deficit: 250 });
    try {
        await Promise.race([creationGuard, creation.then(result => { throw new Error('creation ended before guard: ' + JSON.stringify(result)); })]);
        const correctionId = crypto.randomUUID();
        const correctionBody = { date: metricDate, weight: 86 };
        const correction = call('post', '/', correctionBody, correctionId, metricsRouter);
        await Promise.race([metricGuard, correction.then(result => { throw new Error('correction ended before guard: ' + JSON.stringify(result)); })]);
        releaseCreation();
        const created = await creation;
        assert.equal(created.statusCode, 200);
        const saved = await correction;
        assert.equal(saved.statusCode, 200);
        const corrected = await db.goal.findUniqueOrThrow({ where: { id: created.body.id } });
        assert.equal(corrected.start_weight_grams, 86000);
        assert.equal(corrected.target_weight_grams, 75000);
        assert.equal(corrected.daily_deficit, 250);
        assert.equal(corrected.created_at.toISOString(), created.body.created_at);
        assert.equal((await db.goal.findUniqueOrThrow({ where: { id: weightFirst.body.id } })).start_weight_grams, 85000);
        assert.deepEqual((await call('post', '/', correctionBody, correctionId, metricsRouter)).body, saved.body);
        const goalEvents = await db.syncChange.findMany({ where: { user_id: user.id, operation_id: correctionId, entity_type: 'goal' } });
        assert.equal(goalEvents.length, 1);
        assert.equal(goalEvents[0].payload.start_weight_grams, 86000);
        assert.deepEqual(await db.foodLogDay.findUnique({ where: { id: day.id } }), day);
        console.log('[goal-pace-smoke] PASS: weight-first baseline; concurrent goal-first correction, identity/history preservation and atomic sync/receipt replay.');
    } finally {
        releaseCreation();
        planningLock.lockCaloriePlanningInputs = originalLock;
    }
    /** Force overlap at the shared guard, exercising real PostgreSQL row locks. */
    async function orderedWriters(first, second) {
        let releaseFirst, firstLocked, secondEntered;
        const release = new Promise(resolve => { releaseFirst = resolve; });
        const locked = new Promise(resolve => { firstLocked = resolve; });
        const entered = new Promise(resolve => { secondEntered = resolve; });
        let calls = 0;
        planningLock.lockCaloriePlanningInputs = async (...args) => {
            const ordinal = ++calls;
            if (ordinal === 2) secondEntered();
            await originalLock(...args);
            if (ordinal === 1) { firstLocked(); await release; }
        };
        const firstResult = first();
        let secondResult;
        try {
            await Promise.race([locked, firstResult.then(result => { throw new Error('first writer missed guard: ' + JSON.stringify(result)); })]);
            secondResult = second();
            await Promise.race([entered, secondResult.then(result => { throw new Error('second writer missed guard: ' + JSON.stringify(result)); })]);
            releaseFirst();
            return await Promise.all([firstResult, secondResult]);
        } finally {
            releaseFirst();
            await Promise.allSettled([firstResult, secondResult]);
            planningLock.lockCaloriePlanningInputs = originalLock;
        }
    }

    const currentGoal = await db.goal.findFirstOrThrow({ where: { user_id: user.id }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }] });
    /** Move scenario history together so backdating preserves the active goal identity. */
    async function setActiveGoalFixture(createdAt, startWeight = 90000) {
        await db.goal.updateMany({ where: { user_id: user.id, id: { not: currentGoal.id } },
            data: { created_at: new Date(createdAt.getTime() - 86400000) } });
        await db.goal.update({ where: { id: currentGoal.id }, data: { created_at: createdAt, start_weight_grams: startWeight } });
        const active = await db.goal.findFirstOrThrow({ where: { user_id: user.id }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }] });
        assert.equal(active.id, currentGoal.id, 'scenario fixture must retain the intended active goal');
    }
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [dates.timezoneNow])); }
        static now() { return NativeDate.parse(dates.timezoneNow); }
    };
    try {
        for (const oldZone of ['America/Los_Angeles', 'UTC']) {
            for (const explicitDate of [true, false]) {
                const nextZone = oldZone === 'UTC' ? 'America/Los_Angeles' : 'UTC';
                await db.user.update({ where: { id: user.id }, data: { timezone: oldZone } });
                user.timezone = oldZone; // Authentication snapshot deliberately predates the profile commit.
                await setActiveGoalFixture(new Date(dates.metricGoalCreatedAt));
                const payload = { weight: 84, ...(explicitDate ? { date: dates.timezonePreviousDay } : {}) };
                const operationId = crypto.randomUUID();
                const [profile, metric] = await orderedWriters(
                    () => call('patch', '/profile', { timezone: nextZone }, crypto.randomUUID(), userRouter),
                    () => call('post', '/', payload, operationId, metricsRouter));
                assert.equal(profile.statusCode, 200);
                assert.equal(metric.statusCode, 200);
                assert.equal(metric.body.date.slice(0, 10), explicitDate || nextZone === 'America/Los_Angeles' ? dates.timezonePreviousDay : dates.timezoneUtcDay);
                assert.equal((await db.goal.findUniqueOrThrow({ where: { id: currentGoal.id } })).start_weight_grams,
                    nextZone === 'America/Los_Angeles' ? 84000 : 90000);
                assert.deepEqual((await call('post', '/', payload, operationId, metricsRouter)).body, metric.body);
            }
        }
        console.log('[goal-pace-smoke] PASS: timezone commit before metric acceptance uses current account day, explicit/default dates and stable receipts in both timezone directions.');
    } finally {
        globalThis.Date = NativeDate;
        user.timezone = 'UTC';
        await db.user.update({ where: { id: user.id }, data: { timezone: 'UTC' } });
    }

    const watch = backendRequire('./src/services/watch');
    const session = await db.mobileAuthSession.create({ data: { user_id: user.id, device_id: 'synthetic-watch', device_platform: 'WEAR_OS',
        access_token_hash: crypto.randomUUID(), refresh_token_hash: crypto.randomUUID(),
        access_expires_at: new Date(Date.now() + 3600000), refresh_expires_at: new Date(Date.now() + 7200000) } });
    await setActiveGoalFixture(new Date());
    for (const watchFirst of [true, false]) {
        await call('post', '/', { date: metricDate, weight: 85 }, crypto.randomUUID(), metricsRouter);
        const existing = await db.bodyMetric.findUniqueOrThrow({ where: { user_id_date: { user_id: user.id, date: today } } });
        const revision = crypto.createHash('sha256').update(JSON.stringify({ kind: 'body_metric', value: {
            id: existing.id, local_date: metricDate, weight_grams: existing.weight_grams, body_fat_percent: existing.body_fat_percent ?? null
        } })).digest('hex').slice(0, 24);
        const watchOperation = crypto.randomUUID();
        const mutation = watch.parseWatchMutation({ type: 'metric.upsert', payload: {
            local_date: metricDate, weight_grams: 86000, expected_revision: revision
        } }, { timezone: 'UTC' });
        assert.equal(mutation.ok, true);
        const wear = () => watch.executeWatchMutation({ userId: user.id, mobileAuthSessionId: session.id, operationId: watchOperation, mutation });
        const web = () => call('post', '/', { date: metricDate, weight: 87 }, crypto.randomUUID(), metricsRouter);
        const results = await orderedWriters(watchFirst ? wear : web, watchFirst ? web : wear);
        const wearResult = results[watchFirst ? 0 : 1];
        assert.equal(results[watchFirst ? 1 : 0].statusCode, 200);
        assert.equal(wearResult.status, watchFirst ? 200 : 409);
        if (!watchFirst) assert.equal(wearResult.body.code, 'ENTITY_CONFLICT');
        assert.deepEqual((await wear()).body, wearResult.body);
        assert.equal((await db.bodyMetric.findUniqueOrThrow({ where: { id: existing.id } })).weight_grams, 87000);
        assert.equal((await db.goal.findUniqueOrThrow({ where: { id: currentGoal.id } })).start_weight_grams, 87000);
        const wearGoalEvents = await db.syncChange.findMany({ where: { user_id: user.id, operation_id: watchOperation, entity_type: 'goal' } });
        assert.equal(wearGoalEvents.length, watchFirst ? 1 : 0);
        if (watchFirst) assert.equal(wearGoalEvents[0].payload.start_weight_grams, 86000);
    }
    const historicalKey = dates.historicalDay;
    const historicalDate = new Date(historicalKey + 'T00:00:00Z');
    assert.equal(await db.bodyMetric.findUnique({ where: { user_id_date: { user_id: user.id, date: historicalDate } } }),
        null, 'historical create must not reuse a date populated by another scenario');
    const historicalMutation = watch.parseWatchMutation({ type: 'metric.upsert', payload: {
        local_date: historicalKey, weight_grams: 89000, expected_revision: null
    } }, { timezone: 'UTC' });
    assert.equal(historicalMutation.ok, true);
    const historicalResult = await watch.executeWatchMutation({ userId: user.id, mobileAuthSessionId: session.id,
        operationId: crypto.randomUUID(), mutation: historicalMutation });
    assert.equal(historicalResult.status, 200, JSON.stringify(historicalResult.body));
    assert.equal((await db.goal.findUniqueOrThrow({ where: { id: currentGoal.id } })).start_weight_grams, 87000);
    console.log('[goal-pace-smoke] PASS: web/Wear metric writes in both lock orders avoid deadlock, correct same-day baseline with one goal sync event, retain historical baseline, stale-revision conflict and receipt replay.');

    const importRouter = backendRequire('./src/routes/imports').default;
    const importHandler = importRouter.stack.find(layer => layer.route?.path === '/loseit/execute').route.stack.at(-1).handle;
    const AdmZip = backendRequire('adm-zip');
    /** Exercise the import route with one synthetic weight row and an explicit conflict mode. */
    async function importWeight(date, weight, mode) {
        const zip = new AdmZip();
        const [year, month, day] = date.split('-');
        zip.addFile('weights.csv', Buffer.from('Date,Weight,Last Updated,Deleted\n' + month + '/' + day + '/' + year + ',' + weight + ',,\n'));
        const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
        await importHandler({ user, file: { buffer: zip.toBuffer() }, body: {
            weight_unit: 'KG', food_conflict_mode: 'MERGE', weight_conflict_mode: mode, include_body_fat: false
        } }, res);
        assert.equal(res.statusCode, 200);
        return res.body;
    }
    await db.bodyMetric.deleteMany({ where: { user_id: user.id, date: today } });
    const goalBeforeImport = await db.goal.findUniqueOrThrow({ where: { id: currentGoal.id } });
    const eventCount = () => db.syncChange.count({ where: { user_id: user.id, entity_type: 'goal', entity_id: String(currentGoal.id) } });
    const beforeImportEvents = await eventCount();
    await importWeight(metricDate, 85, 'KEEP');
    assert.deepEqual(await db.goal.findUniqueOrThrow({ where: { id: currentGoal.id } }), { ...goalBeforeImport, start_weight_grams: 85000 });
    assert.equal(await eventCount(), beforeImportEvents + 1);
    await importWeight(metricDate, 86, 'KEEP');
    assert.equal((await db.goal.findUniqueOrThrow({ where: { id: currentGoal.id } })).start_weight_grams, 85000);
    assert.equal(await eventCount(), beforeImportEvents + 1);
    await importWeight(metricDate, 84, 'OVERWRITE');
    assert.equal((await db.goal.findUniqueOrThrow({ where: { id: currentGoal.id } })).start_weight_grams, 84000);
    assert.equal(await eventCount(), beforeImportEvents + 2);
    await importWeight(historicalKey, 83, 'OVERWRITE');
    await importWeight(metricDate, 84, 'OVERWRITE');
    assert.equal((await db.goal.findUniqueOrThrow({ where: { id: currentGoal.id } })).start_weight_grams, 84000);
    assert.equal(await eventCount(), beforeImportEvents + 2);
    assert.deepEqual(await db.foodLogDay.findUnique({ where: { id: day.id } }), day);
    console.log('[goal-pace-smoke] PASS: import create/overwrite corrects only the same-day baseline and sync; KEEP, historical edits and repeated identical imports preserve baseline/history without duplicate goal events.');
    globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [dates.timezoneNow])); }
        static now() { return NativeDate.parse(dates.timezoneNow); }
    };
    try {
        for (const oldZone of ['America/Los_Angeles', 'UTC']) {
            for (const importDate of [dates.timezonePreviousDay, dates.timezoneUtcDay]) {
                const nextZone = oldZone === 'UTC' ? 'America/Los_Angeles' : 'UTC';
                const acceptedDay = nextZone === 'UTC' ? dates.timezoneUtcDay : dates.timezonePreviousDay;
                await db.user.update({ where: { id: user.id }, data: { timezone: oldZone } });
                user.timezone = oldZone;
                await setActiveGoalFixture(new Date(dates.importGoalCreatedAt));
                const [profile, imported] = await orderedWriters(
                    () => call('patch', '/profile', { timezone: nextZone }, crypto.randomUUID(), userRouter),
                    () => importWeight(importDate, 82, 'OVERWRITE'));
                assert.equal(profile.statusCode, 200);
                const isFuture = importDate > acceptedDay;
                assert.equal(imported.importedWeights + imported.updatedWeights, isFuture ? 0 : 1);
                assert.equal(imported.skippedWeights, isFuture ? 1 : 0);
                assert.equal(imported.warnings.some(warning => warning.includes('future')), isFuture);
                assert.equal((await db.goal.findUniqueOrThrow({ where: { id: currentGoal.id } })).start_weight_grams,
                    importDate === acceptedDay ? 82000 : 90000);
            }
        }
        console.log('[goal-pace-smoke] PASS: import timezone overlap repartitions rows, counts and future warnings using the locked account day in both directions; only that day corrects the baseline.');
        await db.user.update({ where: { id: user.id }, data: { timezone: 'UTC' } });
        user.timezone = 'UTC';
        const futureDate = new Date(dates.timezoneUtcDay + 'T00:00:00Z');
        await db.bodyMetric.deleteMany({ where: { user_id: user.id, date: futureDate } });
        const beforeFutureGoal = await db.goal.findUniqueOrThrow({ where: { id: currentGoal.id } });
        const futureOperation = crypto.randomUUID();
        const futureMutation = watch.parseWatchMutation({ type: 'metric.upsert', payload: {
            local_date: dates.timezoneUtcDay, weight_grams: 81000, expected_revision: null
        } }, { timezone: 'UTC' });
        assert.equal(futureMutation.ok, true);
        const saveFuture = () => watch.executeWatchMutation({ userId: user.id, mobileAuthSessionId: session.id,
            operationId: futureOperation, mutation: futureMutation });
        const [profile, rejected] = await orderedWriters(
            () => call('patch', '/profile', { timezone: 'America/Los_Angeles' }, crypto.randomUUID(), userRouter), saveFuture);
        assert.equal(profile.statusCode, 200);
        assert.equal(rejected.status, 400);
        assert.equal(rejected.body.message, 'Weight date cannot be in the future');
        assert.equal(await db.bodyMetric.findUnique({ where: { user_id_date: { user_id: user.id, date: futureDate } } }), null);
        assert.deepEqual(await db.goal.findUniqueOrThrow({ where: { id: currentGoal.id } }), beforeFutureGoal);
        assert.equal(await db.syncChange.count({ where: { user_id: user.id, operation_id: futureOperation } }), 0);
        await db.user.update({ where: { id: user.id }, data: { timezone: 'UTC' } });
        assert.deepEqual((await saveFuture()).body, rejected.body);
        console.log('[goal-pace-smoke] PASS: Wear parsed before a timezone change rejects a now-future date after the lock, leaves metric/goal/sync untouched and replays its original rejection.');
        await db.user.update({ where: { id: user.id }, data: { timezone: 'America/Los_Angeles' } });
        user.timezone = 'America/Los_Angeles';
        const newlyValidOperation = crypto.randomUUID();
        const newlyValidMutation = watch.parseWatchMutation({ type: 'metric.upsert', payload: {
            local_date: dates.timezoneUtcDay, weight_grams: 81000, expected_revision: null
        } }, { timezone: 'America/Los_Angeles' });
        assert.equal(newlyValidMutation.ok, true, 'syntax parsing must defer the account-day decision');
        const saveNewlyValid = () => watch.executeWatchMutation({ userId: user.id, mobileAuthSessionId: session.id,
            operationId: newlyValidOperation, mutation: newlyValidMutation });
        const [forwardProfile, accepted] = await orderedWriters(
            () => call('patch', '/profile', { timezone: 'UTC' }, crypto.randomUUID(), userRouter), saveNewlyValid);
        assert.equal(forwardProfile.statusCode, 200);
        assert.equal(accepted.status, 200);
        assert.equal((await db.bodyMetric.findUniqueOrThrow({ where: { user_id_date: { user_id: user.id, date: futureDate } } })).weight_grams, 81000);
        assert.equal((await db.goal.findUniqueOrThrow({ where: { id: currentGoal.id } })).start_weight_grams, 81000);
        assert.equal(await db.syncChange.count({ where: { user_id: user.id, operation_id: newlyValidOperation, entity_type: 'goal' } }), 1);
        assert.deepEqual((await saveNewlyValid()).body, accepted.body);
        console.log('[goal-pace-smoke] PASS: Wear parsed with an older account day accepts a newly valid date after the timezone lock, corrects its baseline once and replays the receipt.');
    } finally {
        globalThis.Date = NativeDate;
        user.timezone = 'UTC';
        await db.user.update({ where: { id: user.id }, data: { timezone: 'UTC' } });
    }
    console.log('[goal-pace-smoke] PASS: real Postgres continuity, receipt replay, concurrent stale-editor rejection, immutable completed comparison and intentional new identity.');
}
finally {
    if (disconnectDatabase)
        await disconnectDatabase();
    if (/^calibrate_upgrade_smoke_goal_pace_[a-f0-9]+$/.test(schema))
        await admin.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await admin.end();
    process.env.DATABASE_URL = rawUrl;
}
