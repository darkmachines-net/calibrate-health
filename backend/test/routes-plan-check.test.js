/** @file Authenticated summary reads use only the session owner and never trigger report generation. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadRoute(calls) {
    const stubs = {
        '../src/services/planCheck': { getPlanCheckSummary: async id => { calls.push(['summary', id]); return { windows: [] }; } },
        '../src/services/weeklyReports/reports': { listWeeklyReports: async id => { calls.push(['reports', id]); return []; } },
        '../src/services/weeklyReports/tasks': { getReportTaskConfiguration: () => null }
    };
    const previous = [];
    for (const [name, value] of Object.entries(stubs)) {
        const path = require.resolve(name); previous.push([path, require.cache[path]]);
        const stub = new Module(path); stub.loaded = true; stub.exports = value; require.cache[path] = stub;
    }
    delete require.cache[require.resolve('../src/routes/planCheck')];
    const router = require('../src/routes/planCheck').default;
    for (const [path, cached] of previous) { if (cached) require.cache[path] = cached; else delete require.cache[path]; }
    return router.stack.find(layer => layer.route).route.stack[0].handle;
}

function response() {
    return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, setHeader(name, value) { this.headers[name] = value; } };
}

test('anonymous requests are rejected before reading account evidence', async () => {
    const calls = [];
    const res = response();
    await loadRoute(calls)({ isAuthenticated: () => false }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(calls, []);
});

test('reads are scoped to the session owner, non-cacheable, and do not generate reports', async () => {
    const calls = [];
    const res = response();
    await loadRoute(calls)({ isAuthenticated: () => true, user: { id: 17 }, query: { userId: 99 } }, res);
    assert.deepEqual(calls, [['summary', 17], ['reports', 17]]);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.body.weeklyReportsEnabled, false);
    assert.deepEqual(res.body.weeklyReports, []);
});
