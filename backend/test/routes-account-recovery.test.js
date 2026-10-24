/** @file Regression coverage for routes account recovery: known-account SMTP work cannot delay the generic password reset response. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const instance = new Module(resolvedPath);
  instance.exports = exports;
  instance.loaded = true;
  require.cache[resolvedPath] = instance;
}

function loadRouter({ prismaStub, accountTokensStub }) {
  const paths = {
    database: require.resolve('../src/config/database'),
    tokens: require.resolve('../src/services/accountTokens'),
    passport: require.resolve('passport'),
    bcrypt: require.resolve('bcryptjs'),
    credentials: require.resolve('../src/services/credentialVerification'),
    auth: require.resolve('../src/routes/auth')
  };
  const previous = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, require.cache[path]]));
  delete require.cache[paths.auth];
  stubModule(paths.database, prismaStub);
  stubModule(paths.tokens, accountTokensStub);
  stubModule(paths.passport, { authenticate: () => () => {} });
  stubModule(paths.bcrypt, { genSalt: async () => 'salt', hash: async () => 'hash' });
  const loaded = require('../src/routes/auth');
  for (const [key, path] of Object.entries(paths)) {
    if (key === 'auth') continue;
    if (previous[key]) require.cache[path] = previous[key];
    else delete require.cache[path];
  }
  return loaded.default ?? loaded;
}

function getHandler(router, path) {
  const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods?.post);
  assert.ok(layer);
  return layer.route.stack[0].handle;
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    locals: { requestId: '0123456789abcdef' },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

const never = () => new Promise(() => {});
const afterImmediate = () => new Promise((resolve) => setImmediate(resolve));

test('known-account SMTP work cannot delay the generic password reset response', async () => {
  let deliveryStarted = false;
  const router = loadRouter({
    prismaStub: { user: { findFirst: async () => ({ id: 7, email: 'known@example.com' }) } },
    accountTokensStub: {
      sendPasswordReset: () => { deliveryStarted = true; return never(); },
      sendEmailVerification: async () => true,
      confirmEmailVerification: async () => null,
      resetPasswordWithToken: async () => false
    }
  });
  const res = response();
  await getHandler(router, '/password-reset/request')({
    body: { email: 'known@example.com' },
    isAuthenticated: () => false
  }, res);
  assert.equal(res.statusCode, 202);
  assert.equal(deliveryStarted, false);
  await afterImmediate();
  assert.equal(deliveryStarted, true);
});

test('known and unknown recovery requests have the same immediate response', async () => {
  let known = false;
  let deliveries = 0;
  const router = loadRouter({
    prismaStub: { user: { findFirst: async () => known ? { id: 7, email: 'known@example.com' } : null } },
    accountTokensStub: {
      sendPasswordReset: () => { deliveries += 1; return never(); },
      sendEmailVerification: () => { deliveries += 1; return never(); },
      confirmEmailVerification: async () => null,
      resetPasswordWithToken: async () => false
    }
  });
  for (const path of ['/password-reset/request', '/email-verification/resend']) {
    const unknownRes = response();
    await getHandler(router, path)({ body: { email: 'unknown@example.com' }, isAuthenticated: () => false }, unknownRes);
    known = true;
    const knownRes = response();
    await getHandler(router, path)({ body: { email: 'known@example.com' }, isAuthenticated: () => false }, knownRes);
    known = false;
    assert.deepEqual(knownRes.body, unknownRes.body);
    assert.equal(knownRes.statusCode, 202);
  }
  assert.equal(deliveries, 0);
  await afterImmediate();
  assert.equal(deliveries, 2);
});
