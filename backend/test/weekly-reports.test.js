/** @file Weekly report isolation, idempotency, lease recovery, local Sunday fan-out and Google identity verification. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadWithStubs(target, stubs) {
    const previous = new Map();
    for (const [name, exports] of Object.entries(stubs)) {
        const path = require.resolve(name);
        previous.set(path, require.cache[path]);
        const stub = new Module(path); stub.exports = exports; stub.loaded = true; require.cache[path] = stub;
    }
    delete require.cache[require.resolve(target)];
    const result = require(target);
    for (const [path, cached] of previous) { if (cached) require.cache[path] = cached; else delete require.cache[path]; }
    return result;
}

function reportHarness(options = {}) {
    let row;
    let calls = 0;
    const now = new Date('2026-11-08T12:00:00Z');
    const prisma = {
        user: { findFirst: async () => options.ineligible ? null : ({ timezone: 'America/Los_Angeles', language: 'en' }) },
        goal: { findMany: async () => [] },
        weeklyProgressReport: {
            upsert: async ({ where, create }) => {
                assert.equal(where.user_id_report_date.user_id, 17);
                row ??= { id: 1, status: 'PENDING', lease_expires_at: null, ...create };
                return { ...row };
            },
            updateMany: async ({ where, data }) => {
                if (!row || where.id !== row.id) return { count: 0 };
                if (where.lease_token && where.lease_token !== row.lease_token) return { count: 0 };
                if (where.OR && (row.status === 'READY' || row.lease_expires_at > now)) return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            },
            findMany: async ({ where, take }) => { assert.equal(where.user_id, 17); assert.equal(where.status, 'READY'); assert.equal(take, 12); return row?.status === 'READY' ? [row] : []; }
        }
    };
    const service = loadWithStubs('../src/services/weeklyReports/reports', {
        '../src/config/database': prisma,
        '../src/utils/accountAccessSerialization': { CURRENT_ACCOUNT_ACCESS_WHERE: { email_verified_at: { not: null } } },
        '../src/services/firebaseAuthority': { firebaseSessionAllowed: async () => !options.revoked },
        '../src/services/planCheck': { getPlanCheckSummary: async () => ({ trackingDays: options.trackingDays ?? 28, needsWeighIn: true, windows: [] }) },
        '../src/services/weeklyReports/openai': {
            getWeeklyReportConfiguration: () => options.disabled ? null : ({ model: 'test-model' }),
            analyzeWeeklyProgress: async evidence => {
                calls++;
                assert.deepEqual(Object.keys(evidence).sort(), ['goal', 'language', 'tracking']);
                if (options.analyze) await options.analyze();
                return { summary: 'Report.', highlights: ['Coverage is partial.'], nextStep: 'Log weight.' };
            }
        }
    });
    return { service, now, calls: () => calls, row: () => row };
}

test('one persisted report per account/Sunday, including repeated successful delivery and account-scoped history', async () => {
    const h = reportHarness();
    await h.service.generateWeeklyReport(17, new Date('2026-11-08'), h.now);
    await h.service.generateWeeklyReport(17, new Date('2026-11-08'), h.now);
    assert.equal(h.calls(), 1);
    assert.equal(h.row().status, 'READY');
    assert.equal(h.row().lease_token, null);
    assert.equal((await h.service.listWeeklyReports(17))[0].summary, 'Report.');
});

test('provider failure releases the claim and a later retry succeeds', async () => {
    let failing = true;
    const h = reportHarness({ analyze: async () => { if (failing) throw new Error('Transient provider failure'); } });
    await assert.rejects(h.service.generateWeeklyReport(17, new Date('2026-11-08'), h.now));
    assert.equal(h.row().status, 'PENDING');
    assert.equal(h.row().lease_token, null);
    failing = false;
    await h.service.generateWeeklyReport(17, new Date('2026-11-08'), h.now);
    assert.equal(h.calls(), 2);
    assert.equal(h.row().status, 'READY');
});

test('concurrent duplicate waits for the active lease rather than calling the provider twice', async () => {
    let finish;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { finish = resolve; });
    const h = reportHarness({ analyze: async () => { started(); await gate; } });
    const first = h.service.generateWeeklyReport(17, new Date('2026-11-08'), h.now);
    await entered;
    await assert.rejects(h.service.generateWeeklyReport(17, new Date('2026-11-08'), h.now), /already being generated/);
    finish();
    await first;
    assert.equal(h.calls(), 1);
});

test('skips missing configuration, revoked/ineligible users, young histories and invalid report dates', async () => {
    for (const options of [{ disabled: true }, { ineligible: true }, { revoked: true }, { trackingDays: 6 }]) {
        const h = reportHarness(options);
        await h.service.generateWeeklyReport(17, new Date('2026-11-08'), h.now);
        assert.equal(h.calls(), 0);
    }
    const h = reportHarness();
    for (const date of ['2026-11-09', '2026-11-15', '2026-10-25']) await h.service.generateWeeklyReport(17, new Date(date), h.now);
    assert.equal(h.calls(), 0);
});

test('local Sundays enqueue eligible users only and OIDC checks exact verified identity', async t => {
    const names = ['OPENAI_IDENTITY_PROVIDER_ID', 'OPENAI_WEEKLY_REPORT_MODEL', 'WEEKLY_REPORT_TASK_QUEUE', 'WEEKLY_REPORT_TASK_ORIGIN', 'WEEKLY_REPORT_TASK_SERVICE_ACCOUNT', 'OPENAI_SERVICE_ACCOUNT_ID'];
    const previous = names.map(name => process.env[name]);
    const values = ['idp-synthetic', 'test-model', 'projects/test/locations/us-central1/queues/reports', 'https://example.run.app', 'worker@test.iam.gserviceaccount.com', 'sa-synthetic'];
    names.forEach((name, i) => { process.env[name] = values[i]; });
    t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
    const queued = [];
    let identity = { email: values[4], email_verified: true };
    const taskService = loadWithStubs('../src/services/weeklyReports/tasks', {
        'google-auth-library': {
            GoogleAuth: class { async getClient() { return { request: async request => { queued.push(request.data.task); } }; } },
            OAuth2Client: class { async verifyIdToken({ audience }) { assert.equal(audience, values[3]); return { getPayload: () => identity }; } }
        },
        '../src/utils/accountAccessSerialization': { CURRENT_ACCOUNT_ACCESS_WHERE: {} },
        '../src/config/database': {
            user: { findMany: async () => [{ id: 1, timezone: 'America/Los_Angeles' }, { id: 2, timezone: 'Asia/Tokyo' }] },
            bodyMetric: { findFirst: async () => ({ id: 1 }) }, foodLog: { findFirst: async () => null }, foodLogDay: { findFirst: async () => null },
            weeklyProgressReport: { findUnique: async () => null }
        }
    });
    await taskService.dispatchWeeklyReports(0, new Date('2026-11-08T03:00:00Z'));
    assert.equal(queued.length, 1);
    assert.deepEqual(JSON.parse(Buffer.from(queued[0].httpRequest.body, 'base64')), { userId: 2, reportDate: '2026-11-08' });
    assert.equal(queued[0].httpRequest.oidcToken.serviceAccountEmail, values[4]);
    assert.equal(await taskService.isReportTaskAuthorized(undefined), false);
    assert.equal(await taskService.isReportTaskAuthorized('Bearer signed'), true);
    identity = { email: 'other@test.iam.gserviceaccount.com', email_verified: true };
    assert.equal(await taskService.isReportTaskAuthorized('Bearer signed'), false);
    identity = { email: values[4], email_verified: false };
    assert.equal(await taskService.isReportTaskAuthorized('Bearer signed'), false);
    assert.equal(taskService.getReportTaskConfiguration({}), null);
});
