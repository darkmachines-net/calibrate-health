/** @file Regression coverage for routes calibration: calibration route requires authentication. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadRouter(service) {
  const routePath = require.resolve('../src/routes/calibration');
  const servicePath = require.resolve('../src/services/calibration');
  const operationsPath = require.resolve('../src/services/clientOperations');
  const previousService = require.cache[servicePath];
  const previousOperations = require.cache[operationsPath];
  delete require.cache[routePath];
  class CalibrationConflictError extends Error {}
  class ClientOperationConflictError extends Error {}
  stubModule(servicePath, { CalibrationConflictError, ...service });
  stubModule(operationsPath, {
    ClientOperationConflictError,
    parseClientOperationId: (value) => value === undefined ? undefined : String(value)
  });
  const loaded = require('../src/routes/calibration');
  if (previousService) require.cache[servicePath] = previousService;
  else delete require.cache[servicePath];
  if (previousOperations) require.cache[operationsPath] = previousOperations;
  else delete require.cache[operationsPath];
  return loaded.default ?? loaded;
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function handler(router, method, path) {
  const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods?.[method]);
  assert.ok(layer);
  return layer.route.stack[0].handle;
}

test('calibration route requires authentication', async () => {
  const router = loadRouter({});
  const middleware = router.stack.find((candidate) => !candidate.route).handle;
  const res = response();
  let nextCalled = false;
  await middleware({ isAuthenticated: () => false }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('calibration status delegates to on-demand evaluation', async () => {
  const expected = { evaluation: { status: 'insight' } };
  const router = loadRouter({ buildCalibrationStatus: async (userId) => ({ ...expected, userId }) });
  const res = response();
  await handler(router, 'get', '/status')({ user: { id: 17 } }, res);
  assert.deepEqual(res.body, { ...expected, userId: 17 });
});

test('apply route forwards the recommendation and operation identifiers', async () => {
  let received = null;
  const router = loadRouter({
    applyCalibrationRecommendation: async (options) => {
      received = options;
      return {
        recommendationId: options.recommendationId,
        targetAdjustmentKcal: -125,
        dailyCalorieBudgetKcal: 1775,
        effectiveLocalDate: '2026-08-01'
      };
    }
  });
  const res = response();
  const req = {
    user: { id: 17 },
    params: { id: '9' },
    headers: { 'x-client-operation-id': 'calibration-op-1' },
    get: () => 'calibration-op-1'
  };
  await handler(router, 'post', '/recommendations/:id/apply')(req, res);
  assert.deepEqual(received, { userId: 17, recommendationId: 9, operationId: 'calibration-op-1' });
  assert.equal(res.body.effectiveLocalDate, '2026-08-01');
});

test('cancel route forwards the scheduled recommendation and operation identifiers', async () => {
  let received = null;
  const router = loadRouter({
    cancelScheduledCalibrationChange: async (options) => {
      received = options;
      return { recommendation: { id: options.recommendationId }, scheduledChange: null };
    }
  });
  const res = response();
  const req = {
    user: { id: 17 },
    params: { id: '9' },
    headers: { 'x-client-operation-id': 'calibration-op-2' },
    get: () => 'calibration-op-2'
  };
  await handler(router, 'post', '/recommendations/:id/cancel')(req, res);
  assert.deepEqual(received, { userId: 17, recommendationId: 9, operationId: 'calibration-op-2' });
  assert.equal(res.body.recommendation.id, 9);
  assert.equal(res.body.scheduledChange, null);
});
