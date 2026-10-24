/** @file Regression coverage for daily calorie plans postgres: daily plan lifecycle through real Postgres and normal phone/Wear handlers. */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

test('daily plan lifecycle through real Postgres and normal phone/Wear handlers', {
  skip: !process.env.DAILY_CALORIE_PLAN_DATABASE_URL,
  timeout: 90000
}, async t => {
  const { databaseUrlForSchema, migrateDeploy } = await import('../../scripts/postgres-populated-upgrade-smoke.mjs');
  const { Client } = require('pg');
  const rawUrl = process.env.DAILY_CALORIE_PLAN_DATABASE_URL;
  const schema = `calibrate_upgrade_smoke_daily_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: rawUrl });
  await admin.connect();
  let disconnect;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    process.env.DATABASE_URL = databaseUrlForSchema(rawUrl, schema);
    migrateDeploy(process.env.DATABASE_URL, path.resolve('prisma/schema.prisma'));
    const { default: db, disconnectDatabase } = require('../src/config/database');
    disconnect = disconnectDatabase;
    const userRouter = require('../src/routes/user').default;
    const daysRouter = require('../src/routes/foodDays').default;
    const foodRouter = require('../src/routes/food').default;
    const goalsRouter = require('../src/routes/goals').default;
    const syncRouter = require('../src/routes/sync').default;
    const { buildWatchSnapshot, executeWatchMutation, parseWatchMutation } = require('../src/services/watch');
    const { observeCurrentCaloriePlan } = require('../src/services/dailyCaloriePlans');
    const { lockCaloriePlanningInputs } = require('../src/services/caloriePlanningLock');
    const { exportAccountData, deleteAccountData } = require('../src/services/accountLifecycle');
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-07-20T19:00:00Z') });
    let sequence = 0;
    async function seed() {
      const id = ++sequence;
      const user = await db.user.create({ data: {
        email: `daily-plan-${id}@synthetic.invalid`, password_hash: 'synthetic', timezone: 'America/Los_Angeles',
        created_at: new Date('2026-01-01Z'), date_of_birth: new Date('1990-01-01Z'), sex: 'MALE',
        height_mm: 1800, activity_level: 'MODERATE'
      } });
      await db.bodyMetric.create({ data: { user_id: user.id, date: new Date('2026-07-01Z'), weight_grams: 85000 } });
      await db.goal.create({ data: { user_id: user.id, start_weight_grams: 90000, target_weight_grams: 75000,
        daily_deficit: 500, created_at: new Date('2026-01-01Z') } });
      const session = await db.mobileAuthSession.create({ data: { user_id: user.id, device_id: 'synthetic', device_platform: 'WEAR_OS',
        access_token_hash: `access-${id}`, refresh_token_hash: `refresh-${id}`,
        access_expires_at: new Date('2027-01-01Z'), refresh_expires_at: new Date('2027-01-01Z') } });
      return { user, session };
    }
    async function call(router, method, route, user, { body = {}, query = {}, params = {}, operation } = {}) {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; }, set() { return this; },
        send(body) { this.body = body; return this; } };
      const handler = router.stack.find(layer => layer.route?.path === route && layer.route.methods[method]).route.stack[0].handle;
      await handler({ user, body, query, params, headers: { 'x-client-operation-id': operation } }, res);
      assert.ok(res.statusCode < 500, `${method} ${route}: ${JSON.stringify(res.body)}`);
      return res;
    }
    async function complete(user, date, operation) {
      return call(daysRouter, 'patch', '/', user, { body: { date, status: 'COMPLETE' }, operation });
    }
    const dayRead = (user, date) => call(daysRouter, 'get', '/', user, { query: { date } });
    const profile = user => call(userRouter, 'get', '/profile', user);
    const observeD = '2026-07-20T19:00:00Z', nextDay = '2026-07-21T19:00:00Z';

    await t.test('phone: D observation survives D+1 profile/pace changes, lost reply, reopen, intake edit and sync', async () => {
      t.mock.timers.setTime(Date.parse(observeD));
      const { user } = await seed();
      const initial = await profile(user);
      const target = initial.body.calorieSummary.dailyCalorieTarget;
      assert.equal(await db.foodLogDay.count({ where: { user_id: user.id } }), 0);
      const evidence = await db.dailyCaloriePlan.findFirst({ where: { user_id: user.id } });
      t.mock.timers.setTime(Date.parse(nextDay));
      assert.equal((await call(userRouter, 'patch', '/profile', user, { body: { height_mm: 1900 } })).statusCode, 200);
      const pace = await call(goalsRouter, 'get', '/pace-options', user);
      assert.equal((await call(goalsRouter, 'patch', '/:id/pace', user, { params: { id: pace.body.goal.id },
        body: { daily_deficit: 250, expected_plan_version: pace.body.expected_plan_version }, operation: 'phone-pace-0001' })).statusCode, 200);
      const first = await complete(user, '2026-07-20', 'phone-complete-0001');
      assert.equal(first.body.calorie_comparison.target_kcal, target);
      assert.equal(first.body.calorie_comparison.captured_at, new Date().toISOString());
      assert.deepEqual((await complete(user, '2026-07-20', 'phone-complete-0001')).body, first.body);
      assert.deepEqual((await dayRead(user, '2026-07-20')).body.calorie_comparison, first.body.calorie_comparison);
      await call(daysRouter, 'patch', '/', user, { body: { date: '2026-07-20', status: 'OPEN' }, operation: 'phone-reopen-0001' });
      const entry = await call(foodRouter, 'post', '/', user, { body: { date: '2026-07-20', meal_period: 'DINNER', name: 'Synthetic', calories: 1800 }, operation: 'phone-food-0001' });
      assert.equal(entry.statusCode, 200);
      const again = await complete(user, '2026-07-20', 'phone-complete-0002');
      assert.deepEqual(again.body.calorie_comparison, { ...first.body.calorie_comparison, consumed_kcal: 1800 });
      const range = await call(daysRouter, 'get', '/range', user, { query: { start: '2026-07-20', end: '2026-07-20' } });
      assert.deepEqual(range.body.days[0].calorie_comparison, again.body.calorie_comparison);
      const sync = await call(syncRouter, 'get', '/changes', user);
      assert.ok(sync.body.changes.some(change => change.payload?.calorie_comparison?.target_kcal === target));
      const retained = await db.dailyCaloriePlan.findUnique({ where: { id: evidence.id } });
      assert.equal(retained.observed_at.toISOString(), evidence.observed_at.toISOString());
      assert.deepEqual(retained.inputs, evidence.inputs);
    });

    await t.test('Wear: observed revision stays unchanged, late completion replays and stale writers conflict', async () => {
      t.mock.timers.setTime(Date.parse(observeD));
      const { user, session } = await seed();
      const before = await buildWatchSnapshot({ userId: user.id, mobileAuthSessionId: session.id });
      const [repeated, concurrent] = await Promise.all([
        buildWatchSnapshot({ userId: user.id, mobileAuthSessionId: session.id }),
        buildWatchSnapshot({ userId: user.id, mobileAuthSessionId: session.id })
      ]);
      assert.equal(before.revision, repeated.revision);
      assert.equal(before.revision, concurrent.revision);
      assert.equal(before.food_day.revision, null);
      t.mock.timers.setTime(Date.parse(nextDay));
      await call(userRouter, 'patch', '/profile', user, { body: { activity_level: 'VERY_ACTIVE' } });
      const mutation = parseWatchMutation({ type: 'food_day.set_complete', payload: {
        local_date: before.local_date, is_complete: true, expected_revision: before.food_day.revision
      } }, { timezone: user.timezone });
      assert.equal(mutation.ok, true);
      const args = { userId: user.id, mobileAuthSessionId: session.id, operationId: 'wear-complete-0001', mutation };
      const [saved, duplicate] = await Promise.all([executeWatchMutation(args), executeWatchMutation(args)]);
      assert.equal(saved.status, 200);
      assert.deepEqual(duplicate, saved);
      assert.equal(saved.body.food_day.calorie_comparison.target_kcal, before.calories.target);
      assert.deepEqual(await executeWatchMutation(args), saved);
      assert.equal((await executeWatchMutation({ ...args, operationId: 'wear-stale-0002' })).status, 409);
      assert.deepEqual((await dayRead(user, before.local_date)).body.calorie_comparison, saved.body.food_day.calorie_comparison);
    });

    await t.test('legacy completed and populated open reads stay snapshot-free; previews and old edits do not create history', async () => {
      const { user } = await seed();
      for (const [date, status] of [['2026-07-18', 'COMPLETE'], ['2026-07-19', 'OPEN']]) {
        await db.foodLogDay.create({ data: { user_id: user.id, local_date: new Date(date), status, origin: 'IMPORT' } });
        await db.foodLog.create({ data: { user_id: user.id, date: new Date(date), local_date: new Date(date), meal_period: 'DINNER', name: 'Legacy synthetic', calories: 1800 } });
        assert.equal((await dayRead(user, date)).body.calorie_comparison, null);
      }
      await call(goalsRouter, 'get', '/pace-options', user);
      assert.equal(await db.dailyCaloriePlan.count({ where: { user_id: user.id } }), 0);
      await call(foodRouter, 'post', '/', user, { body: { date: '2026-07-19', meal_period: 'DINNER', name: 'Late synthetic', calories: 100 } });
      const missing = await complete(user, '2026-07-19', 'legacy-complete-0001');
      assert.equal(missing.body.calorie_comparison, null);
      assert.equal(await db.dailyCaloriePlan.count({ where: { user_id: user.id } }), 0);
      await profile(user);
      assert.equal(await db.dailyCaloriePlan.count({ where: { user_id: user.id, local_date: { lt: new Date('2026-07-21Z') } } }), 0);
    });

    await t.test('identical legacy API reads reproduce old/current/fixed target selection at exact revisions', async () => {
      const { execFileSync } = require('node:child_process');
      const fs = require('node:fs');
      const ts = require('typescript');
      const Module = require('node:module');
      const root = path.resolve('..');
      const before = 'ec35bbd10b888bbc00a9c066bfc38d39e779e6e7';
      const regressed = '5006a0d5d9a6a51eaaf3f3219add36e365d549c3';
      const oldScreen = execFileSync('git', ['show', `${before}:mobile/app/(tabs)/(today)/today.tsx`], { cwd: root, encoding: 'utf8' });
      const source = ts.createSourceFile('today.tsx', oldScreen, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const names = ['calorieSummary', 'planStatus', 'planIsAvailable', 'target'];
      const declarations = new Map();
      function visit(node) {
        if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) declarations.set(node.name.getText(source), node.getText(source));
        ts.forEachChild(node, visit);
      }
      visit(source);
      assert.equal(declarations.size, names.length);
      const oldTarget = new Function('profileQuery', 'hasPendingWeightChange', `${names.map(name => `const ${declarations.get(name)};`).join('\n')} return target;`);
      function selector(text) {
        const compiled = new Module('synthetic-day-presentation');
        compiled._compile(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, 'synthetic-day-presentation.js');
        return compiled.exports;
      }
      const baseline = selector(execFileSync('git', ['show', `${regressed}:mobile/src/food/dayPresentation.ts`], { cwd: root, encoding: 'utf8' }));
      const fixed = selector(fs.readFileSync(path.join(root, 'mobile/src/food/dayPresentation.ts'), 'utf8'));
      const { user } = await seed();
      const currentProfile = (await profile(user)).body;
      for (const [date, status] of [['2026-07-18', 'COMPLETE'], ['2026-07-19', 'OPEN']]) {
        await db.foodLogDay.create({ data: { user_id: user.id, local_date: new Date(date), status, origin: 'IMPORT' } });
        await db.foodLog.create({ data: { user_id: user.id, date: new Date(date), local_date: new Date(date), meal_period: 'DINNER', name: 'Same synthetic legacy intake', calories: 1800 } });
        const day = (await dayRead(user, date)).body;
        const logs = (await call(foodRouter, 'get', '/', user, { query: { date } })).body;
        assert.equal(logs.reduce((sum, log) => sum + log.calories, 0), 1800);
        const currentTarget = currentProfile.calorieSummary.dailyCalorieTarget;
        assert.equal(oldTarget({ data: currentProfile }, false), currentTarget);
        assert.equal(baseline.getFoodDayCalorieTarget({ day, isToday: false, currentTarget }), null);
        assert.deepEqual(fixed.getFoodDayCaloriePresentation({ day, isToday: false, currentTarget, hasFoodEntries: true }),
          { target: currentTarget, source: 'fallback' });
        assert.equal(day.calorie_comparison, null);
      }
    });

    await t.test('committed unavailable transitions and timezone conflicts remain unavailable at late completion', async () => {
      for (const change of [{ height_mm: null }, { timezone: 'UTC' }]) {
        t.mock.timers.setTime(Date.parse(observeD));
        const { user } = await seed();
        await profile(user);
        await call(userRouter, 'patch', '/profile', user, { body: change });
        if (change.timezone) await call(userRouter, 'patch', '/profile', user, { body: { timezone: user.timezone } });
        t.mock.timers.setTime(Date.parse(nextDay));
        assert.equal((await complete(user, '2026-07-20', `unavailable-${user.id}`)).body.calorie_comparison, null);
      }
    });

    await t.test('a reader waiting across midnight observes committed inputs on the new local date', async () => {
      t.mock.timers.setTime(Date.parse('2026-07-21T06:59:59Z'));
      const { user } = await seed();
      let unlock, locked;
      const ready = new Promise(resolve => { locked = resolve; });
      const release = new Promise(resolve => { unlock = resolve; });
      const writer = db.$transaction(async tx => {
        await lockCaloriePlanningInputs(tx, user.id);
        await tx.user.update({ where: { id: user.id }, data: { height_mm: 1900 } });
        locked(); await release;
      });
      await ready;
      const reader = db.$transaction(tx => observeCurrentCaloriePlan(tx, user.id));
      // Wait for an actual lock waiter, not a timing guess.
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%UPDATE%User%timezone%' LIMIT 1");
        if (result.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      t.mock.timers.setTime(Date.parse('2026-07-21T07:00:01Z'));
      unlock(); await writer;
      const observed = await reader;
      assert.equal(waiting, true);
      assert.equal(observed.localToday, '2026-07-21');
      assert.equal(observed.user.height_mm, 1900);
      assert.equal(await db.dailyCaloriePlan.count({ where: { user_id: user.id, local_date: new Date('2026-07-20Z') } }), 0);
    });

    await t.test('observations export with provenance and cascade when the account is deleted', async () => {
      const { user } = await seed();
      await profile(user);
      const exported = await exportAccountData(user.id);
      assert.equal(exported.version, 11);
      assert.equal(exported.daily_calorie_plans.length, 1);
      assert.equal(exported.daily_calorie_plans[0].timezone, user.timezone);
      assert.equal(exported.daily_calorie_plans[0].inputs.profile.height_mm, 1800);
      assert.equal(await deleteAccountData(user.id), true);
      assert.equal(await db.dailyCaloriePlan.count({ where: { user_id: user.id } }), 0);
    });
  } finally {
    t.mock.timers.reset();
    if (disconnect) await disconnect();
    assert.match(schema, /^calibrate_upgrade_smoke_daily_[a-f0-9]+$/);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
