/** @file Regression coverage for mobile auth middleware: mobile auth middleware lets expired-bearer logout revoke by refresh token. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadMiddleware(authenticateMobileAccessToken) {
  const servicePath = require.resolve('../src/services/mobileAuth');
  const middlewarePath = require.resolve('../src/middleware/mobileAuth');
  const previousService = require.cache[servicePath];
  delete require.cache[middlewarePath];

  const serviceModule = new Module(servicePath);
  serviceModule.exports = { authenticateMobileAccessToken };
  serviceModule.loaded = true;
  require.cache[servicePath] = serviceModule;

  const loaded = require('../src/middleware/mobileAuth');
  if (previousService) require.cache[servicePath] = previousService;
  else delete require.cache[servicePath];
  return loaded.authenticateMobileBearerToken;
}

function createResponse() {
  return {
    locals: {},
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('mobile auth middleware lets expired-bearer logout revoke by refresh token', async () => {
  const middleware = loadMiddleware(async () => ({
    ok: false,
    status: 401,
    message: 'Invalid or expired access token'
  }));
  const req = {
    method: 'POST',
    path: '/auth/mobile/logout',
    get: () => 'Bearer expired'
  };
  const res = createResponse();
  let nextCount = 0;

  await middleware(req, res, () => {
    nextCount += 1;
  });

  assert.equal(nextCount, 1);
  assert.equal(res.statusCode, 200);
});

test('mobile auth middleware still rejects expired bearer tokens on protected routes', async () => {
  const middleware = loadMiddleware(async () => ({
    ok: false,
    status: 401,
    message: 'Invalid or expired access token'
  }));
  const req = {
    method: 'GET',
    path: '/api/user/profile',
    get: () => 'Bearer expired'
  };
  const res = createResponse();
  let nextCount = 0;

  await middleware(req, res, () => {
    nextCount += 1;
  });

  assert.equal(nextCount, 0);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: 'Invalid or expired access token' });
});

test('mobile auth middleware exposes trusted session and device identity', async () => {
  const middleware = loadMiddleware(async () => ({
    ok: true,
    user: { id: 9 },
    sessionId: 73,
    deviceId: 'trusted-device',
    devicePlatform: 'android_phone'
  }));
  const req = {
    method: 'POST',
    path: '/api/notifications/native-subscription',
    get: () => 'Bearer valid'
  };
  const res = createResponse();
  res.locals = {};
  let nextCount = 0;

  await middleware(req, res, () => {
    nextCount += 1;
  });

  assert.equal(nextCount, 1);
  assert.equal(req.user.id, 9);
  assert.equal(req.isAuthenticated(), true);
  assert.equal(res.locals.mobileAuthSessionId, 73);
  assert.equal(res.locals.mobileDeviceId, 'trusted-device');
  assert.equal(res.locals.mobileDevicePlatform, 'android_phone');
});

async function runWearRequest(method, path, sessionId = 73) {
  const middleware = loadMiddleware(async () => ({
    ok: true,
    user: { id: 9 },
    sessionId,
    deviceId: 'watch-install-1',
    devicePlatform: 'wear_os'
  }));
  const req = { method, path, get: () => 'Bearer valid' };
  const res = createResponse();
  let nextCount = 0;
  await middleware(req, res, () => { nextCount += 1; });
  return { res, nextCount };
}

test('Wear bearer sessions are centrally denied from generic and export APIs', async () => {
  for (const path of ['/api/v1/food', '/api/v1/user/account/export']) {
    const { res, nextCount } = await runWearRequest('GET', path);
    assert.equal(nextCount, 0);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {
      message: 'Wear OS session is not allowed for this endpoint',
      code: 'WEAR_SESSION_SCOPE_DENIED',
      retryable: false
    });
  }
});

test('Wear bearer sessions can use watch APIs and limited session self-management', async () => {
  const allowed = [
    ['GET', '/api/v1/watch/today'],
    ['POST', '/auth/mobile/refresh'],
    ['POST', '/auth/mobile/logout'],
    ['DELETE', '/auth/mobile/sessions/73']
  ];
  for (const [method, path] of allowed) {
    const { nextCount, res } = await runWearRequest(method, path);
    assert.equal(nextCount, 1, `${method} ${path}`);
    assert.equal(res.statusCode, 200);
  }
});

test('Wear bearer sessions cannot revoke other sessions or revoke all others', async () => {
  for (const [method, path] of [
    ['GET', '/auth/mobile/sessions'],
    ['DELETE', '/auth/mobile/sessions/74'],
    ['POST', '/auth/mobile/sessions/revoke-others']
  ]) {
    const { res, nextCount } = await runWearRequest(method, path);
    assert.equal(nextCount, 0);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'WEAR_SESSION_SCOPE_DENIED');
  }
});
