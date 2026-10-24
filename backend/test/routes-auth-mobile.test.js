/** @file Regression coverage for routes auth mobile: auth route: POST /mobile/login returns mobile tokens for valid credentials. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');
const { diagnosticsRegistry } = require('../src/observability');

function operationCount(name, field) {
  return diagnosticsRegistry.snapshot().operations[name]?.[field] ?? 0;
}

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
  const mobileAuthPath = require.resolve('../src/services/mobileAuth');
  const mobileAuthDependencyPaths = [
    require.resolve('../src/services/mobileSessionCredentials'),
    require.resolve('../src/services/wearPairing')
  ];
  const authPath = require.resolve('../src/routes/auth');

  const previousDbModule = require.cache[dbPath];
  const previousPassportModule = require.cache[passportPath];
  const previousBcryptModule = require.cache[bcryptPath];
  const previousMobileAuthModule = require.cache[mobileAuthPath];
  const previousMobileAuthDependencyModules = mobileAuthDependencyPaths.map(
    (path) => require.cache[path]
  );
  delete require.cache[authPath];
  delete require.cache[mobileAuthPath];
  mobileAuthDependencyPaths.forEach((path) => delete require.cache[path]);

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
  if (previousMobileAuthModule) require.cache[mobileAuthPath] = previousMobileAuthModule;
  else delete require.cache[mobileAuthPath];
  mobileAuthDependencyPaths.forEach((path, index) => {
    const previous = previousMobileAuthDependencyModules[index];
    if (previous) require.cache[path] = previous;
    else delete require.cache[path];
  });

  return loaded.default ?? loaded;
}

function createRes(locals = {}) {
  return {
    statusCode: 200,
    body: undefined,
    locals,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function getRouteHandler(router, method, path) {
  const layer = router.stack.find(
    (candidate) => candidate.route && candidate.route.path === path && candidate.route.methods?.[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route to exist`);
  return layer.route.stack.at(-1).handle;
}

const dbUser = {
  id: 7,
  email: 'native@example.com',
  password_hash: 'hash',
  credential_security_version: 3,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  weight_unit: 'KG',
  height_unit: 'CM',
  timezone: 'UTC',
  language: 'en',
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

test('auth route: POST /mobile/login returns mobile tokens for valid credentials', async () => {
  const sessionCreates = [];
  const userLookups = [];
  const prismaStub = {
    user: {
      findFirst: async (args) => {
        userLookups.push(args);
        return dbUser;
      },
      updateMany: async ({ where }) => {
        assert.deepEqual(where, { id: dbUser.id, credential_security_version: 3 });
        return { count: 1 };
      },
      findUnique: async () => dbUser
    },
    mobileAuthSession: {
      create: async (args) => {
        sessionCreates.push(args);
        return { id: 1 };
      }
    }
  };
  prismaStub.$transaction = async (action) => action(prismaStub);
  const router = loadAuthRouter({
    prismaStub,
    passportStub: { authenticate: () => () => {} },
    bcryptStub: { compare: async () => true, genSalt: async () => 'salt', hash: async () => 'hash' }
  });
  const handler = getRouteHandler(router, 'post', '/mobile/login');
  const res = createRes();

  await handler(
    {
      body: {
        email: 'NATIVE@example.com',
        password: 'password123',
        device_id: 'device-1',
        device_platform: 'android_phone'
      }
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.email, dbUser.email);
  assert.ok(res.body.access_token);
  assert.ok(res.body.refresh_token);
  assert.deepEqual(userLookups[0].where, {
    email: { equals: 'native@example.com', mode: 'insensitive' }
  });
  assert.equal(sessionCreates[0].data.device_id, 'device-1');
});

test('auth route: POST /mobile/login refuses direct Wear OS password sessions', async () => {
  let lookups = 0;
  const router = loadAuthRouter({
    prismaStub: {
      user: { findFirst: async () => { lookups += 1; return dbUser; } },
      mobileAuthSession: {}
    },
    passportStub: { authenticate: () => () => {} },
    bcryptStub: { compare: async () => true, genSalt: async () => 'salt', hash: async () => 'hash' }
  });
  const handler = getRouteHandler(router, 'post', '/mobile/login');
  const res = createRes();

  await handler({
    body: {
      email: 'native@example.com',
      password: 'password123',
      device_id: 'watch-1',
      device_platform: 'wear_os'
    }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /phone pairing/i);
  assert.equal(lookups, 0);
});

test('auth route: Wear pairing credential issuance rejects browser-only authentication', async () => {
  const router = loadAuthRouter({
    prismaStub: { mobileAuthSession: {} },
    passportStub: { authenticate: () => () => {} },
    bcryptStub: { compare: async () => false, genSalt: async () => 'salt', hash: async () => 'hash' }
  });
  const handler = getRouteHandler(router, 'post', '/mobile/wear/pairing-credential');
  const res = createRes();

  await handler({
    isAuthenticated: () => true,
    user: { id: 7 },
    body: { server_origin: 'https://health.example' }
  }, res);

  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /Android phone session/);
});

test('auth route: Wear pairing credential issuance rejects non-origin server bindings', async () => {
  const router = loadAuthRouter({
    prismaStub: { mobileAuthSession: {} },
    passportStub: { authenticate: () => () => {} },
    bcryptStub: { compare: async () => false, genSalt: async () => 'salt', hash: async () => 'hash' }
  });
  const handler = getRouteHandler(router, 'post', '/mobile/wear/pairing-credential');
  const res = createRes({ mobileAuthSessionId: 9 });

  await handler({
    isAuthenticated: () => true,
    user: { id: 7 },
    body: { server_origin: 'https://health.example/untrusted-path' }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /server_origin/);
});

test('auth route: Wear pairing credential issuance binds the watch key and challenge', async () => {
  let storedCredential;
  const tx = {
    mobileAuthSession: {
      updateMany: async () => ({ count: 1 })
    },
    wearPairingCredential: {
      deleteMany: async () => ({ count: 0 }),
      findMany: async () => [],
      create: async (args) => { storedCredential = args.data; return { id: 1 }; }
    }
  };
  const router = loadAuthRouter({
    prismaStub: { $transaction: async (callback) => callback(tx) },
    passportStub: { authenticate: () => () => {} },
    bcryptStub: { compare: async () => false, genSalt: async () => 'salt', hash: async () => 'hash' }
  });
  const handler = getRouteHandler(router, 'post', '/mobile/wear/pairing-credential');
  const res = createRes({ mobileAuthSessionId: 9 });
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeySpki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  await handler({
    isAuthenticated: () => true,
    user: { id: 7 },
    body: {
      server_origin: 'https://health.example',
      watch_device_id: 'watch-install-1',
      watch_device_name: 'Galaxy Watch Ultra',
      protocol_version: 1,
      watch_public_key_spki: publicKeySpki
    }
  }, res);

  assert.equal(res.statusCode, 201);
  assert.match(res.body.pairing_token, /^wear_pair_/);
  assert.equal(res.body.watch_device_id, 'watch-install-1');
  assert.equal(res.body.protocol_version, 1);
  assert.ok(res.body.challenge);
  assert.equal(storedCredential.watch_public_key_spki, publicKeySpki);
  assert.equal(storedCredential.watch_device_name, 'Galaxy Watch Ultra');
});

test('auth route: POST /mobile/login performs a dummy hash comparison for unknown accounts', async () => {
  let comparedHash = null;
  const router = loadAuthRouter({
    prismaStub: {
      user: { findFirst: async () => null },
      mobileAuthSession: {}
    },
    passportStub: { authenticate: () => () => {} },
    bcryptStub: {
      compare: async (_password, hash) => {
        comparedHash = hash;
        return false;
      },
      genSalt: async () => 'salt',
      hash: async () => 'hash'
    }
  });
  const handler = getRouteHandler(router, 'post', '/mobile/login');
  const res = createRes();

  await handler({
    body: {
      email: 'missing@example.com',
      password: 'password123',
      device_id: 'device-1'
    }
  }, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: 'Invalid email or password' });
  assert.match(comparedHash, /^\$2[aby]\$/);
});

test('auth route: POST /mobile/refresh rejects missing refresh token', async () => {
  const rejectedBefore = operationCount('auth_mobile_refresh', 'rejected');
  const router = loadAuthRouter({
    prismaStub: { user: {}, mobileAuthSession: {} },
    passportStub: { authenticate: () => () => {} },
    bcryptStub: { compare: async () => false, genSalt: async () => 'salt', hash: async () => 'hash' }
  });
  const handler = getRouteHandler(router, 'post', '/mobile/refresh');
  const res = createRes();

  await handler({ body: {} }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'refresh_token is required' });
  assert.equal(operationCount('auth_mobile_refresh', 'rejected'), rejectedBefore + 1);
});

test('auth route: POST /mobile/refresh records invalid or expired refresh tokens', async () => {
  const rejectedBefore = operationCount('auth_mobile_refresh', 'rejected');
  const router = loadAuthRouter({
    prismaStub: {
      mobileAuthSession: { findUnique: async () => null }
    },
    passportStub: { authenticate: () => () => {} },
    bcryptStub: { compare: async () => false, genSalt: async () => 'salt', hash: async () => 'hash' }
  });
  const handler = getRouteHandler(router, 'post', '/mobile/refresh');
  const res = createRes();

  await handler({ body: { refresh_token: 'expired-refresh-token' } }, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: 'Invalid or expired refresh token' });
  assert.equal(operationCount('auth_mobile_refresh', 'rejected'), rejectedBefore + 1);
});

test('auth route: GET /mobile/sessions returns owned active devices', async () => {
  const router = loadAuthRouter({
    prismaStub: {
      mobileAuthSession: {
        findMany: async () => [{
          id: 8,
          device_id: 'pixel-install',
          device_platform: 'ANDROID_PHONE',
          device_name: 'Pixel',
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          last_used_at: null,
          refresh_expires_at: new Date('2026-02-01T00:00:00.000Z')
        }]
      }
    },
    passportStub: { authenticate: () => () => {} },
    bcryptStub: { compare: async () => false, genSalt: async () => 'salt', hash: async () => 'hash' }
  });
  const handler = getRouteHandler(router, 'get', '/mobile/sessions');
  const res = createRes({ mobileAuthSessionId: 8 });

  await handler({ isAuthenticated: () => true, user: { id: 7 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sessions.length, 1);
  assert.equal(res.body.sessions[0].current, true);
  assert.equal(res.body.sessions[0].device_platform, 'android_phone');
});

test('mobile login rejects a credential change during password verification with the generic response', async () => {
  let version = 3;
  let creates = 0;
  const prismaStub = {
    user: { findFirst: async () => ({ ...dbUser }), updateMany: async ({ where }) => ({ count: where.credential_security_version === version ? 1 : 0 }) },
    mobileAuthSession: { create: async () => { creates++; return { id: 1 }; } }
  };
  prismaStub.$transaction = action => action(prismaStub);
  const router = loadAuthRouter({ prismaStub, passportStub: {}, bcryptStub: { compare: async () => { version++; return true; } } });
  const res = createRes();
  await getRouteHandler(router, 'post', '/mobile/login')({ body: { email: dbUser.email, password: 'synthetic', device_id: 'phone', device_platform: 'android_phone' } }, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: 'Invalid email or password' });
  assert.equal(creates, 0);
});
