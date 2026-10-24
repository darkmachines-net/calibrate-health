/** @file Regression coverage for routes auth: auth route: POST /register returns 400 when the email already exists. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const CURRENT_LEGAL_ACCEPTANCE = {
  terms_version: '2026-08-09',
  privacy_version: '2026-08-19',
  accept_terms: true,
  accept_privacy: true
};

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadAuthRouter({ prismaStub, passportStub, bcryptStub }) {
  const dbPath = require.resolve('../src/config/database');
  const passportPath = require.resolve('passport');
  const bcryptPath = require.resolve('bcryptjs');
  const credentialPath = require.resolve('../src/services/credentialVerification');
  const previousCredential = require.cache[credentialPath];
  delete require.cache[credentialPath];
  const authPath = require.resolve('../src/routes/auth');

  const previousDbModule = require.cache[dbPath];
  const previousPassportModule = require.cache[passportPath];
  const previousBcryptModule = require.cache[bcryptPath];

  delete require.cache[authPath];

  stubModule(dbPath, prismaStub);
  stubModule(passportPath, passportStub);
  stubModule(bcryptPath, bcryptStub);

  const loaded = require('../src/routes/auth');

  if (previousCredential) require.cache[credentialPath] = previousCredential;
  else delete require.cache[credentialPath];

  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];

  if (previousPassportModule) require.cache[passportPath] = previousPassportModule;
  else delete require.cache[passportPath];

  if (previousBcryptModule) require.cache[bcryptPath] = previousBcryptModule;
  else delete require.cache[bcryptPath];

  return loaded.default ?? loaded;
}

function createRes() {
  return {
    statusCode: 200,
    body: undefined,
    clearedCookie: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    clearCookie(name, options) {
      this.clearedCookie = { name, options };
      return this;
    }
  };
}

function getRouteHandlers(router, method, path) {
  const layer = router.stack.find(
    (candidate) => candidate.route && candidate.route.path === path && candidate.route.methods?.[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route to exist`);
  return layer.route.stack.map((stackLayer) => stackLayer.handle);
}

test('auth route: POST /register returns 400 when the email already exists', async () => {
  const prismaStub = {
    user: {
      findFirst: async () => ({ id: 1 }),
      create: async () => {
        throw new Error('should not be called');
      }
    }
  };
  const passportStub = { authenticate: () => () => {} };
  const bcryptStub = { genSalt: async () => 'salt', hash: async () => 'hash' };

  const router = loadAuthRouter({ prismaStub, passportStub, bcryptStub });
  const [handler] = getRouteHandlers(router, 'post', '/register');

  const req = { body: { email: 'test@example.com', password: 'password123', ...CURRENT_LEGAL_ACCEPTANCE } };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Unable to create account' });
});

test('auth route: POST /register validates email and password inputs', async () => {
  const prismaStub = {
    user: {
      findFirst: async () => {
        throw new Error('should not be called');
      },
      create: async () => {
        throw new Error('should not be called');
      }
    }
  };
  const passportStub = { authenticate: () => () => {} };
  const bcryptStub = {
    genSalt: async () => {
      throw new Error('should not be called');
    },
    hash: async () => {
      throw new Error('should not be called');
    }
  };

  const router = loadAuthRouter({ prismaStub, passportStub, bcryptStub });
  const [handler] = getRouteHandlers(router, 'post', '/register');

  const invalidEmailRes = createRes();
  await handler({ body: { email: 'not-an-email', password: 'password123' } }, invalidEmailRes);
  assert.equal(invalidEmailRes.statusCode, 400);
  assert.deepEqual(invalidEmailRes.body, { message: 'Invalid email' });

  const shortPasswordRes = createRes();
  await handler({ body: { email: 'test@example.com', password: 'short' } }, shortPasswordRes);
  assert.equal(shortPasswordRes.statusCode, 400);
  assert.deepEqual(shortPasswordRes.body, { message: 'Password must be at least 8 characters' });
});

test('auth route: POST /register creates a user and logs them in', async () => {
  const createdUser = {
    id: 42,
    email: 'test@example.com',
    created_at: new Date('2025-01-01T00:00:00Z'),
    onboarding_completed_at: null,
    weight_unit: 'KG',
    height_unit: 'CM',
    timezone: 'UTC',
    reminder_log_weight_enabled: true,
    reminder_log_food_enabled: true,
    reminder_log_weight_minute: 540,
    reminder_log_food_minute: 540,
    reminder_quiet_hours_start_minute: null,
    reminder_quiet_hours_end_minute: null,
    haptics_enabled: true,
    date_of_birth: null,
    sex: null,
    height_mm: null,
    activity_level: null,
    profile_image: null,
    profile_image_mime_type: null
  };

  let findFirstArgs = null;
  let createArgs = null;
  const prismaStub = {
    user: {
      findFirst: async (args) => {
        findFirstArgs = args;
        return null;
      },
      create: async (args) => {
        createArgs = args;
        return createdUser;
      }
    }
  };
  const passportStub = { authenticate: () => () => {} };
  const bcryptStub = { genSalt: async () => 'salt', hash: async () => 'hash' };

  const router = loadAuthRouter({ prismaStub, passportStub, bcryptStub });
  const [handler] = getRouteHandlers(router, 'post', '/register');

  const req = {
    body: { email: ' TEST@Example.COM ', password: 'password123' },
    login: (_user, cb) => cb(null)
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(findFirstArgs.where, { email: { equals: createdUser.email, mode: 'insensitive' } });
  assert.equal(createArgs.data.email, createdUser.email);
  assert.ok(createArgs.data.email_verified_at instanceof Date);
  assert.equal(createArgs.data.legal_acceptances, undefined);
  assert.deepEqual(res.body, {
    user: {
      id: createdUser.id,
      email: createdUser.email,
      created_at: createdUser.created_at,
      onboarding_completed_at: createdUser.onboarding_completed_at,
      weight_unit: createdUser.weight_unit,
      height_unit: createdUser.height_unit,
      timezone: createdUser.timezone,
      language: 'en',
      reminder_log_weight_enabled: createdUser.reminder_log_weight_enabled,
      reminder_log_food_enabled: createdUser.reminder_log_food_enabled,
      reminder_log_weight_time: '09:00',
      reminder_log_food_time: '09:00',
      reminder_quiet_hours_start: null,
      reminder_quiet_hours_end: null,
      haptics_enabled: createdUser.haptics_enabled,
      date_of_birth: createdUser.date_of_birth,
      sex: createdUser.sex,
      height_mm: createdUser.height_mm,
      activity_level: createdUser.activity_level,
      profile_image_url: null,
      account_access: { state: 'full', email_verified: true, legal_current: true }
    }
  });
});

test('auth route: POST /login normalizes credentials, logs in, and returns the serialized user', async () => {
  const authedUser = {
    id: 7,
    email: 'test@example.com',
    created_at: new Date('2025-01-01T00:00:00Z'),
    weight_unit: 'KG',
    height_unit: 'CM',
    timezone: 'UTC',
    reminder_log_weight_enabled: true,
    reminder_log_food_enabled: true,
    haptics_enabled: true,
    date_of_birth: null,
    sex: null,
    height_mm: null,
    activity_level: null,
    profile_image: null,
    profile_image_mime_type: null
  };

  const prismaStub = { user: {} };
  let authenticateStrategy = null;
  let loggedInUser = null;
  const passportStub = {
    authenticate: (strategy, callback) => {
      authenticateStrategy = strategy;
      return (_req, _res, _next) => {
        callback(null, authedUser);
      };
    }
  };
  const bcryptStub = { genSalt: async () => 'salt', hash: async () => 'hash' };

  const router = loadAuthRouter({ prismaStub, passportStub, bcryptStub });
  const [handler] = getRouteHandlers(router, 'post', '/login');

  const req = {
    body: { email: ' TEST@Example.COM ', password: 'password123', ...CURRENT_LEGAL_ACCEPTANCE },
    login: (user, cb) => {
      loggedInUser = user;
      cb(null);
    }
  };
  const res = createRes();

  let nextError = null;
  await handler(req, res, (err) => {
    nextError = err;
  });

  assert.equal(nextError, null);
  assert.equal(authenticateStrategy, 'local');
  assert.equal(req.body.email, 'test@example.com');
  assert.equal(loggedInUser, authedUser);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.id, authedUser.id);
  assert.equal(res.body.user.email, authedUser.email);
});

test('auth route: POST /login returns JSON errors for invalid or rejected credentials', async () => {
  let authenticateCalls = 0;
  const prismaStub = { user: {} };
  const passportStub = {
    authenticate: (_strategy, callback) => {
      authenticateCalls += 1;
      return (_req, _res, _next) => {
        callback(null, false);
      };
    }
  };
  const bcryptStub = { genSalt: async () => 'salt', hash: async () => 'hash' };

  const router = loadAuthRouter({ prismaStub, passportStub, bcryptStub });
  const [handler] = getRouteHandlers(router, 'post', '/login');

  const invalidShapeRes = createRes();
  await handler({ body: { email: 'not-an-email', password: 'password123' } }, invalidShapeRes, () => {});
  assert.equal(invalidShapeRes.statusCode, 400);
  assert.deepEqual(invalidShapeRes.body, { message: 'Invalid email or password' });
  assert.equal(authenticateCalls, 0);

  const rejectedRes = createRes();
  await handler(
    {
      body: { email: 'test@example.com', password: 'wrong-password' },
      login: () => {
        throw new Error('should not be called');
      }
    },
    rejectedRes,
    () => {}
  );
  assert.equal(rejectedRes.statusCode, 401);
  assert.deepEqual(rejectedRes.body, { message: 'Invalid email or password' });
  assert.equal(authenticateCalls, 1);
});

test('auth route: POST /logout forwards errors from req.logout', async () => {
  const prismaStub = { user: {} };
  const passportStub = { authenticate: () => () => {} };
  const bcryptStub = { genSalt: async () => 'salt', hash: async () => 'hash' };

  const router = loadAuthRouter({ prismaStub, passportStub, bcryptStub });
  const [handler] = getRouteHandlers(router, 'post', '/logout');

  const req = {
    logout: (cb) => cb(new Error('boom'))
  };
  const res = createRes();

  let nextError = null;
  handler(req, res, (err) => {
    nextError = err;
  });

  assert.ok(nextError);
  assert.equal(nextError.message, 'boom');
});

test('auth route: POST /logout destroys the session and clears its cookie', async () => {
  const prismaStub = { user: {} };
  const passportStub = { authenticate: () => () => {} };
  const bcryptStub = { genSalt: async () => 'salt', hash: async () => 'hash' };
  const router = loadAuthRouter({ prismaStub, passportStub, bcryptStub });
  const [handler] = getRouteHandlers(router, 'post', '/logout');
  let destroyed = false;
  const req = {
    logout: (cb) => cb(),
    session: {
      destroy: (cb) => {
        destroyed = true;
        cb();
      }
    }
  };
  const res = createRes();

  handler(req, res, () => {});

  assert.equal(destroyed, true);
  assert.deepEqual(res.clearedCookie, { name: 'cal.sid', options: { path: '/' } });
  assert.deepEqual(res.body, { message: 'Logged out' });
});

test('auth route: GET /me returns 401 when not authenticated', async () => {
  const prismaStub = { user: {} };
  const passportStub = { authenticate: () => () => {} };
  const bcryptStub = { genSalt: async () => 'salt', hash: async () => 'hash' };

  const router = loadAuthRouter({ prismaStub, passportStub, bcryptStub });
  const [handler] = getRouteHandlers(router, 'get', '/me');

  const req = { isAuthenticated: () => false };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: 'Not authenticated' });
});


test('hosted registration requires explicit current legal versions', async () => {
  const previous = { NODE_ENV: process.env.NODE_ENV, CALIBRATE_HOSTED_SERVICE: process.env.CALIBRATE_HOSTED_SERVICE };
  process.env.NODE_ENV = 'production';
  process.env.CALIBRATE_HOSTED_SERVICE = 'true';
  try {
    const prismaStub = { user: { findFirst: async () => { throw new Error('should not be called'); } } };
    const router = loadAuthRouter({
      prismaStub,
      passportStub: { authenticate: () => () => {} },
      bcryptStub: { genSalt: async () => 'salt', hash: async () => 'hash' }
    });
    const [handler] = getRouteHandlers(router, 'post', '/register');

    const missing = createRes();
    await handler({ body: { email: 'test@example.com', password: 'password123' } }, missing);
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.body.code, 'INVALID_LEGAL_ACCEPTANCE');

    const outdated = createRes();
    await handler({ body: {
      email: 'test@example.com',
      password: 'password123',
      ...CURRENT_LEGAL_ACCEPTANCE,
      terms_version: '2025-01-01'
    } }, outdated);
    assert.equal(outdated.statusCode, 400);
    assert.equal(outdated.body.code, 'INVALID_LEGAL_VERSION');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('auth route: hosted registration fails closed when account email is unavailable', async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    CALIBRATE_HOSTED_SERVICE: process.env.CALIBRATE_HOSTED_SERVICE,
    EMAIL_DELIVERY_MODE: process.env.EMAIL_DELIVERY_MODE
  };
  process.env.NODE_ENV = 'production';
  process.env.CALIBRATE_HOSTED_SERVICE = 'true';
  process.env.EMAIL_DELIVERY_MODE = 'disabled';
  try {
    const router = loadAuthRouter({
      prismaStub: { user: { findFirst: async () => { throw new Error('should not be called'); } } },
      passportStub: { authenticate: () => () => {} },
      bcryptStub: { genSalt: async () => 'salt', hash: async () => 'hash' }
    });
    const [handler] = getRouteHandlers(router, 'post', '/register');
    const res = createRes();
    await handler({ body: {
      email: 'test@example.com',
      password: 'password123',
      ...CURRENT_LEGAL_ACCEPTANCE
    } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'EMAIL_DELIVERY_UNAVAILABLE');
    assert.equal(res.body.retryable, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('auth route: verification resend and reset request do not reveal account existence', async () => {
  let known = false;
  const router = loadAuthRouter({
    prismaStub: {
      user: {
        findFirst: async () => known ? { id: 7, email: 'known@example.com' } : null
      }
    },
    passportStub: { authenticate: () => () => {} },
    bcryptStub: { genSalt: async () => 'salt', hash: async () => 'hash' }
  });
  const [resend] = getRouteHandlers(router, 'post', '/email-verification/resend');
  const [requestReset] = getRouteHandlers(router, 'post', '/password-reset/request');

  for (const handler of [resend, requestReset]) {
    const unknownRes = createRes();
    await handler({
      body: { email: 'unknown@example.com' },
      isAuthenticated: () => false
    }, unknownRes);
    known = true;
    const knownRes = createRes();
    await handler({
      body: { email: 'known@example.com' },
      isAuthenticated: () => false
    }, knownRes);
    known = false;
    assert.equal(unknownRes.statusCode, 202);
    assert.equal(knownRes.statusCode, 202);
    assert.deepEqual(knownRes.body, unknownRes.body);
  }
});

test('browser login clears rejected authenticated state even when session cleanup fails', async () => {
  const { BrowserLoginRejected } = require('../src/utils/browserLoginCredentials');
  const user = { id: 7 };
  const router = loadAuthRouter({ prismaStub: {}, bcryptStub: {}, passportStub: {
    authenticate: (_strategy, callback) => (_req, _res, _next) => callback(null, user)
  } });
  const [handler] = getRouteHandlers(router, 'post', '/login');
  const res = createRes();
  let done;
  const completed = new Promise(resolve => { done = resolve; });
  const originalJson = res.json;
  res.json = function(value) { originalJson.call(this, value); done(); return this; };
  const req = {
    body: { email: 'synthetic@example.invalid', password: 'synthetic' }, user,
    session: { destroy(callback) { callback(new Error('synthetic cleanup failure')); } },
    login(_user, callback) { void callback(new BrowserLoginRejected()); }
  };
  handler(req, res, error => { throw error; });
  await completed;
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: 'Invalid email or password' });
  assert.equal(req.session, null);
  assert.equal(req.user, undefined);
  assert.ok(res.clearedCookie);
});
