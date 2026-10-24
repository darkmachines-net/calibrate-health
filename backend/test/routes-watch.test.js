/** @file Regression coverage for routes watch: watch routes reject non-Wear principals. */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Module = require('node:module');
const { diagnosticsRegistry } = require('../src/observability');

function operationCount(name, field) {
  return diagnosticsRegistry.snapshot().operations[name]?.[field] ?? 0;
}

function loadWatchRouter(watchService) {
  const servicePath = require.resolve('../src/services/watch');
  const operationsPath = require.resolve('../src/services/clientOperations');
  const routePath = require.resolve('../src/routes/watch');
  const previous = require.cache[servicePath];
  const previousOperations = require.cache[operationsPath];
  delete require.cache[routePath];
  const stub = new Module(servicePath);
  stub.exports = watchService;
  stub.loaded = true;
  require.cache[servicePath] = stub;
  const operationsStub = new Module(operationsPath);
  operationsStub.exports = {
    ClientOperationConflictError: class ClientOperationConflictError extends Error {},
    parseClientOperationId: (value) => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string') return null;
      const normalized = value.trim();
      return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalized) ? normalized : null;
    }
  };
  operationsStub.loaded = true;
  require.cache[operationsPath] = operationsStub;
  const router = require('../src/routes/watch').default;
  if (previous) require.cache[servicePath] = previous;
  else delete require.cache[servicePath];
  if (previousOperations) require.cache[operationsPath] = previousOperations;
  else delete require.cache[operationsPath];
  return router;
}

async function createServer(t, watchService) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const platform = req.get('x-test-platform');
    res.locals.mobileDevicePlatform = platform;
    if (platform === 'wear_os') {
      res.locals.mobileAuthSessionId = 73;
      req.user = { id: 9, timezone: 'America/Los_Angeles' };
      req.isAuthenticated = () => true;
    } else {
      req.isAuthenticated = () => Boolean(req.user);
    }
    next();
  });
  app.use('/api/v1/watch', loadWatchRouter(watchService));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test('watch routes reject non-Wear principals', async (t) => {
  const origin = await createServer(t, {});
  const response = await fetch(`${origin}/api/v1/watch`, { headers: { 'x-test-platform': 'android_phone' } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'WATCH_SESSION_REQUIRED');
});

test('watch snapshot returns a private ETag and supports conditional 304', async (t) => {
  const snapshot = { revision: 'rev-1', local_date: '2026-07-11' };
  const origin = await createServer(t, {
    buildWatchSnapshot: async () => snapshot,
    watchSnapshotEtag: (revision) => `W/"watch-${revision}"`
  });
  const headers = { 'x-test-platform': 'wear_os' };
  const first = await fetch(`${origin}/api/v1/watch`, { headers });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('etag'), 'W/"watch-rev-1"');
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  const cached = await fetch(`${origin}/api/v1/watch`, {
    headers: { ...headers, 'if-none-match': 'W/"watch-rev-1"' }
  });
  assert.equal(cached.status, 304);
  const listed = await fetch(`${origin}/api/v1/watch`, {
    headers: { ...headers, 'if-none-match': '"other", "watch-rev-1"' }
  });
  assert.equal(listed.status, 304);
  const wildcard = await fetch(`${origin}/api/v1/watch`, {
    headers: { ...headers, 'if-none-match': '*' }
  });
  assert.equal(wildcard.status, 304);
});

test('watch mutations require an operation id and trusted session provenance', async (t) => {
  const rejectedBefore = operationCount('watch_mutation_reconciliation', 'rejected');
  const successesBefore = operationCount('watch_mutation_reconciliation', 'successes');
  let executed;
  const origin = await createServer(t, {
    parseWatchMutation: (body) => ({ ok: true, type: body.type, payload: body.payload }),
    executeWatchMutation: async (options) => {
      executed = options;
      return { status: 200, body: { ok: true } };
    }
  });
  const request = {
    type: 'metric.upsert',
    payload: { weight_grams: 80000, local_date: '2026-07-11', expected_revision: null }
  };
  const missing = await fetch(`${origin}/api/v1/watch/mutations`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-platform': 'wear_os' }, body: JSON.stringify(request)
  });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).message, /operation-id is required/);

  const accepted = await fetch(`${origin}/api/v1/watch/mutations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-platform': 'wear_os', 'x-client-operation-id': 'watch-op-0001' },
    body: JSON.stringify(request)
  });
  assert.equal(accepted.status, 200);
  assert.equal(executed.userId, 9);
  assert.equal(executed.mobileAuthSessionId, 73);
  assert.equal(executed.operationId, 'watch-op-0001');
  assert.equal(operationCount('watch_mutation_reconciliation', 'rejected'), rejectedBefore + 1);
  assert.equal(operationCount('watch_mutation_reconciliation', 'successes'), successesBefore + 1);
});
