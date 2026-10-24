/** @file Regression coverage for account access middleware: restricted sessions receive stable verification and legal error codes. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadMiddleware(getAccountAccess) {
  const servicePath = require.resolve('../src/services/accountAccess');
  const middlewarePath = require.resolve('../src/middleware/accountAccess');
  const previousService = require.cache[servicePath];
  delete require.cache[middlewarePath];
  stubModule(servicePath, { getAccountAccess });
  const loaded = require('../src/middleware/accountAccess');
  if (previousService) require.cache[servicePath] = previousService;
  else delete require.cache[servicePath];
  return loaded;
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

const authenticatedRequest = (path, method = 'GET') => ({
  path,
  method,
  user: { id: 7 },
  isAuthenticated: () => true
});

test('restricted sessions receive stable verification and legal error codes', async () => {
  const verification = { state: 'email_verification_required', email_verified: false, legal_current: true };
  const { enforceAccountAccess } = loadMiddleware(async () => verification);
  const res = response();
  let nextCalled = false;
  await enforceAccountAccess(authenticatedRequest('/api/v1/food'), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'EMAIL_VERIFICATION_REQUIRED');
  assert.deepEqual(res.body.account_access, verification);

  const legal = { state: 'legal_acceptance_required', email_verified: true, legal_current: false };
  const loaded = loadMiddleware(async () => legal);
  const legalRes = response();
  await loaded.enforceAccountAccess(authenticatedRequest('/api/v1/goals'), legalRes, () => {});
  assert.equal(legalRes.body.code, 'LEGAL_ACCEPTANCE_REQUIRED');
});

test('restricted sessions retain only trust, export, deletion, config, and logout access', async () => {
  let lookups = 0;
  const { enforceAccountAccess } = loadMiddleware(async () => {
    lookups += 1;
    return { state: 'email_verification_required', email_verified: false, legal_current: false };
  });
  const allowed = [
    ['/auth/email-verification/resend', 'POST'],
    ['/auth/logout', 'POST'],
    ['/api/v1/legal/status', 'GET'],
    ['/api/legal/acceptance', 'POST'],
    ['/api/v1/client-config', 'GET'],
    ['/api/v1/user/account/export', 'GET'],
    ['/api/user/account', 'DELETE'],
    ['/terms', 'GET'],
    ['/privacy', 'GET'],
    ['/support', 'GET']
  ];
  for (const [path, method] of allowed) {
    let nextCalled = false;
    await enforceAccountAccess(authenticatedRequest(path, method), response(), () => { nextCalled = true; });
    assert.equal(nextCalled, true, `${method} ${path}`);
  }
  assert.equal(lookups, 0);
});

test('full accounts continue to ordinary authenticated routes', async () => {
  const full = { state: 'full', email_verified: true, legal_current: true };
  const { enforceAccountAccess } = loadMiddleware(async () => full);
  const res = response();
  let nextCalled = false;
  await enforceAccountAccess(authenticatedRequest('/api/v1/food'), res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(res.locals.accountAccess, full);
});
