/** @file Regression coverage for routes legal: self-hosted deployments do not expose Calibrate hosted legal-consent routes. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadRouter(serviceStub) {
  const servicePath = require.resolve('../src/services/accountAccess');
  const routePath = require.resolve('../src/routes/legal');
  const previous = require.cache[servicePath];
  delete require.cache[routePath];
  stubModule(servicePath, serviceStub);
  const loaded = require('../src/routes/legal');
  if (previous) require.cache[servicePath] = previous;
  else delete require.cache[servicePath];
  return loaded.default ?? loaded;
}

function handler(router, method, path) {
  const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods?.[method]);
  assert.ok(layer);
  return layer.route.stack.at(-1).handle;
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    locals: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

const fullStatus = {
  account_access: { state: 'full', email_verified: true, legal_current: true },
  required: { terms_version: '2026-08-09', privacy_version: '2026-08-19' },
  accepted: { terms_version: '2026-08-09', privacy_version: '2026-08-19', accepted_at: '2026-08-19T00:00:00.000Z' }
};
test('self-hosted deployments do not expose Calibrate hosted legal-consent routes', () => {
  const router = loadRouter({
    acceptCurrentLegalDocuments: async () => fullStatus,
    getLegalStatus: async () => fullStatus
  });
  const hostedBoundary = router.stack.find((candidate) => !candidate.route).handle;
  const res = response();
  let nextCalled = false;

  hostedBoundary({}, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'LEGAL_CONSENT_NOT_REQUIRED');
});

test('legal acceptance rejects outdated versions with a stable code', async () => {
  let accepted = false;
  const router = loadRouter({ acceptCurrentLegalDocuments: async () => { accepted = true; }, getLegalStatus: async () => fullStatus });
  const res = response();
  await handler(router, 'post', '/acceptance')({
    user: { id: 7 },
    body: { terms_version: 'outdated', privacy_version: '2026-08-19', accept_terms: true, accept_privacy: true }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'INVALID_LEGAL_VERSION');
  assert.equal(accepted, false);
});

test('legal status and current acceptance return the same account-access contract', async () => {
  const service = {
    getLegalStatus: async (userId) => { assert.equal(userId, 7); return fullStatus; },
    acceptCurrentLegalDocuments: async (userId) => { assert.equal(userId, 7); return fullStatus; }
  };
  const router = loadRouter(service);
  const statusRes = response();
  await handler(router, 'get', '/status')({ user: { id: 7 } }, statusRes);
  assert.deepEqual(statusRes.body, fullStatus);

  const acceptanceRes = response();
  await handler(router, 'post', '/acceptance')({
    user: { id: 7 },
    body: { terms_version: '2026-08-09', privacy_version: '2026-08-19', accept_terms: true, accept_privacy: true }
  }, acceptanceRes);
  assert.deepEqual(acceptanceRes.body, fullStatus);
});
test('legal acceptance requires explicit affirmative consent', async () => {
  let accepted = false;
  const router = loadRouter({
    acceptCurrentLegalDocuments: async () => { accepted = true; },
    getLegalStatus: async () => fullStatus
  });
  const res = response();
  await handler(router, 'post', '/acceptance')({
    user: { id: 7 },
    body: { terms_version: '2026-08-09', privacy_version: '2026-08-19' }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'INVALID_LEGAL_ACCEPTANCE');
  assert.equal(accepted, false);
});
