/** @file Regression coverage for routes user: user route: rejects unauthenticated requests via router.use middleware. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadUserRouter({ prismaStub, bcryptStub, accountLifecycleStub, mcpOAuthStub }) {
  const dbPath = require.resolve('../src/config/database');
  const bcryptPath = require.resolve('bcryptjs');
  const credentialPath = require.resolve('../src/services/credentialVerification');
  const previousCredential = require.cache[credentialPath];
  delete require.cache[credentialPath];
  const mobileAuthPath = require.resolve('../src/services/mobileAuth');
  const browserSessionsPath = require.resolve('../src/services/browserSessions');
  const accountLifecyclePath = require.resolve('../src/services/accountLifecycle');
  const clientOperationsPath = require.resolve('../src/services/clientOperations');
  const caloriePlanningPath = require.resolve('../src/services/caloriePlanning');
  const caloriePlanReviewPath = require.resolve('../src/services/caloriePlanReview');
  const mcpOAuthPath = require.resolve('../src/services/mcpOAuth');
  const userPath = require.resolve('../src/routes/user');

  const previousDbModule = require.cache[dbPath];
  const previousBcryptModule = require.cache[bcryptPath];
  const previousMobileAuthModule = require.cache[mobileAuthPath];
  const previousBrowserSessionsModule = require.cache[browserSessionsPath];
  const previousAccountLifecycleModule = require.cache[accountLifecyclePath];
  const previousClientOperationsModule = require.cache[clientOperationsPath];
  const previousCaloriePlanningModule = require.cache[caloriePlanningPath];
  const previousCaloriePlanReviewModule = require.cache[caloriePlanReviewPath];
  const previousMcpOAuthModule = require.cache[mcpOAuthPath];

  delete require.cache[userPath];
  delete require.cache[mobileAuthPath];
  delete require.cache[browserSessionsPath];
  delete require.cache[accountLifecyclePath];
  delete require.cache[clientOperationsPath];
  delete require.cache[caloriePlanningPath];
  delete require.cache[caloriePlanReviewPath];
  delete require.cache[mcpOAuthPath];

  const normalizedPrismaStub = {
    dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    $executeRaw: async () => 1,
    ...prismaStub,
    caloriePlanRevision: {
      findFirst: async () => null,
      findMany: async () => [],
      ...(prismaStub.caloriePlanRevision ?? {})
    },
    syncChange: {
      create: async () => ({ id: 1n }),
      ...(prismaStub.syncChange ?? {})
    }
  };
  normalizedPrismaStub.$transaction ??= async (callback) => callback(normalizedPrismaStub);
  stubModule(dbPath, normalizedPrismaStub);
  stubModule(bcryptPath, bcryptStub);
  if (accountLifecycleStub) stubModule(accountLifecyclePath, accountLifecycleStub);
  stubModule(mcpOAuthPath, mcpOAuthStub ?? {
    mcpOAuthService: {
      listConnectionsForUser: async () => [],
      revokeConnectionForUser: async () => false,
      revokeAllForUser: async () => 0
    }
  });

  const loaded = require('../src/routes/user');

  if (previousCredential) require.cache[credentialPath] = previousCredential;
  else delete require.cache[credentialPath];

  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];

  if (previousBcryptModule) require.cache[bcryptPath] = previousBcryptModule;
  else delete require.cache[bcryptPath];

  if (previousMobileAuthModule) require.cache[mobileAuthPath] = previousMobileAuthModule;
  else delete require.cache[mobileAuthPath];

  if (previousBrowserSessionsModule) require.cache[browserSessionsPath] = previousBrowserSessionsModule;
  else delete require.cache[browserSessionsPath];

  if (previousAccountLifecycleModule) require.cache[accountLifecyclePath] = previousAccountLifecycleModule;
  else delete require.cache[accountLifecyclePath];

  if (previousClientOperationsModule) require.cache[clientOperationsPath] = previousClientOperationsModule;
  else delete require.cache[clientOperationsPath];

  if (previousCaloriePlanningModule) require.cache[caloriePlanningPath] = previousCaloriePlanningModule;
  else delete require.cache[caloriePlanningPath];
  if (previousCaloriePlanReviewModule) require.cache[caloriePlanReviewPath] = previousCaloriePlanReviewModule;
  else delete require.cache[caloriePlanReviewPath];
  if (previousMcpOAuthModule) require.cache[mcpOAuthPath] = previousMcpOAuthModule;
  else delete require.cache[mcpOAuthPath];

  return loaded.default ?? loaded;
}

function createRes(locals = {}) {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    clearedCookie: null,
    locals,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    clearCookie(name, options) {
      this.clearedCookie = { name, options };
      return this;
    }
  };
}

function getIsAuthenticatedMiddleware(router) {
  const layer = router.stack.find((candidate) => !candidate.route);
  assert.ok(layer, 'Expected router.use(isAuthenticated) middleware to exist');
  return layer.handle;
}

function getRouteHandler(router, method, path) {
  const layer = router.stack.find(
    (candidate) => candidate.route && candidate.route.path === path && candidate.route.methods?.[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route to exist`);
  assert.equal(layer.route.stack.length, 1);
  return layer.route.stack[0].handle;
}

test('user route: rejects unauthenticated requests via router.use middleware', async () => {
  const prismaStub = { user: {} };
  const bcryptStub = {};

  const router = loadUserRouter({ prismaStub, bcryptStub });
  const isAuthenticated = getIsAuthenticatedMiddleware(router);

  const req = { isAuthenticated: () => false };
  const res = createRes();

  let nextCalled = false;
  isAuthenticated(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: 'Not authenticated' });
});

test('user route: GET /me returns 404 when the user row is missing', async () => {
  const prismaStub = {
    user: {
      findUnique: async () => null
    }
  };
  const bcryptStub = {};

  const router = loadUserRouter({ prismaStub, bcryptStub });
  const handler = getRouteHandler(router, 'get', '/me');

  const req = { user: { id: 7 } };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: 'User not found' });
});

test('user route: GET /me returns serialized user data', async () => {
  const dbUser = {
    id: 7,
    email: 'user@example.com',
    created_at: new Date('2025-01-01T00:00:00Z'),
    onboarding_completed_at: null,
    weight_unit: 'KG',
    height_unit: 'CM',
    timezone: 'UTC',
    reminder_log_weight_enabled: true,
    reminder_log_food_enabled: true,
    reminder_log_weight_minute: 450,
    reminder_log_food_minute: 1_155,
    reminder_quiet_hours_start_minute: 1_320,
    reminder_quiet_hours_end_minute: 360,
    haptics_enabled: true,
    date_of_birth: null,
    sex: null,
    height_mm: null,
    activity_level: null,
    profile_image: new Uint8Array([1, 2, 3]),
    profile_image_mime_type: 'image/png'
  };

  const prismaStub = {
    user: {
      findUnique: async () => dbUser
    }
  };
  const bcryptStub = {};

  const router = loadUserRouter({ prismaStub, bcryptStub });
  const handler = getRouteHandler(router, 'get', '/me');

  const req = { user: { id: 7 } };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    user: {
      id: dbUser.id,
      email: dbUser.email,
      created_at: dbUser.created_at,
      onboarding_completed_at: dbUser.onboarding_completed_at,
      weight_unit: dbUser.weight_unit,
      height_unit: dbUser.height_unit,
      timezone: dbUser.timezone,
      language: 'en',
      reminder_log_weight_enabled: dbUser.reminder_log_weight_enabled,
      reminder_log_food_enabled: dbUser.reminder_log_food_enabled,
      reminder_log_weight_time: '07:30',
      reminder_log_food_time: '19:15',
      reminder_quiet_hours_start: '22:00',
      reminder_quiet_hours_end: '06:00',
      haptics_enabled: dbUser.haptics_enabled,
      date_of_birth: dbUser.date_of_birth,
      sex: dbUser.sex,
      height_mm: dbUser.height_mm,
      activity_level: dbUser.activity_level,
      profile_image_url: 'data:image/png;base64,AQID',
      account_access: { state: 'full', email_verified: true, legal_current: true }
    }
  });
});

test('user route: PUT /profile-image validates data_url input', async () => {
  const prismaStub = { user: {} };
  const bcryptStub = {};

  const router = loadUserRouter({ prismaStub, bcryptStub });
  const handler = getRouteHandler(router, 'put', '/profile-image');

  const req = { user: { id: 7 }, body: {} };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Missing data_url' });
});

test('user route: PUT /profile-image rejects invalid profile image payloads', async () => {
  const prismaStub = { user: {} };
  const bcryptStub = {};

  const router = loadUserRouter({ prismaStub, bcryptStub });
  const handler = getRouteHandler(router, 'put', '/profile-image');

  const req = { user: { id: 7 }, body: { data_url: 'not-a-data-url' } };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid profile image payload' });
});

test('user route: PUT /profile-image stores bytes and returns a data URL', async () => {
  const updatedUser = {
    id: 7,
    email: 'user@example.com',
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
    profile_image: new Uint8Array([1, 2, 3]),
    profile_image_mime_type: 'image/png'
  };

  const prismaStub = {
    user: {
      update: async () => updatedUser
    }
  };
  const bcryptStub = {};

  const router = loadUserRouter({ prismaStub, bcryptStub });
  const handler = getRouteHandler(router, 'put', '/profile-image');

  const req = {
    user: { id: 7 },
    body: { data_url: 'data:image/png;base64,AQID' }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.profile_image_url, 'data:image/png;base64,AQID');
});

test('user route: PATCH /password validates request shape and rejects identical passwords', async () => {
  const prismaStub = { user: {} };
  const bcryptStub = { compare: async () => true, hash: async () => 'hash' };

  const router = loadUserRouter({ prismaStub, bcryptStub });
  const handler = getRouteHandler(router, 'patch', '/password');

  const missingBodyRes = createRes();
  await handler({ user: { id: 7 }, body: null }, missingBodyRes);
  assert.equal(missingBodyRes.statusCode, 400);
  assert.deepEqual(missingBodyRes.body, { message: 'Invalid request body' });

  const samePasswordRes = createRes();
  await handler(
    { user: { id: 7 }, body: { current_password: 'password123', new_password: 'password123' } },
    samePasswordRes
  );
  assert.equal(samePasswordRes.statusCode, 400);
  assert.deepEqual(samePasswordRes.body, { message: 'New password must be different from current password' });

  const utf8LimitRes = createRes();
  await handler(
    { user: { id: 7 }, body: { current_password: 'current', new_password: '\ud83d\ude00'.repeat(19) } },
    utf8LimitRes
  );
  assert.equal(utf8LimitRes.statusCode, 400);
  assert.deepEqual(utf8LimitRes.body, { message: 'New password must be at most 72 bytes' });
});

test('user route: PATCH /password updates password when current password matches', async () => {
  let updated = false;
  let sessionLookup = null;
  let browserSessionDeletion = null;
  let mcpOAuthRevocation = null;
  let mcpOAuthCodeDeletion = null;

  const prismaStub = {
    $transaction: async (operations) => Promise.all(operations),
    user: {
      findUnique: async () => ({ id: 7, password_hash: 'old-hash' }),
      update: async () => {
        updated = true;
      }
    },
    mobileAuthSession: {
      findMany: async (args) => {
        sessionLookup = args;
        return [{ id: 12 }];
      },
      updateMany: async () => ({ count: 1 })
    },
    nativePushSubscription: {
      updateMany: async () => ({ count: 1 })
    },
    mcpOAuthGrant: {
      updateMany: async (args) => {
        mcpOAuthRevocation = args;
        return { count: 1 };
      }
    },
    mcpOAuthAuthorizationCode: {
      deleteMany: async (args) => {
        mcpOAuthCodeDeletion = args;
        return { count: 1 };
      }
    },
    sessionStore: {
      deleteMany: async (args) => {
        browserSessionDeletion = args;
        return { count: 2 };
      }
    }
  };
  const bcryptStub = {
    compare: async () => true,
    hash: async () => 'new-hash'
  };

  const router = loadUserRouter({ prismaStub, bcryptStub });
  const handler = getRouteHandler(router, 'patch', '/password');

  const req = {
    user: { id: 7 },
    sessionID: 'browser-session-11',
    body: { current_password: 'current', new_password: 'new-password' }
  };
  const res = createRes({ mobileAuthSessionId: 11 });

  await handler(req, res);

  assert.equal(updated, true);
  assert.deepEqual(sessionLookup.where.id, { not: 11 });
  assert.deepEqual(browserSessionDeletion, {
    where: { user_id: 7, sid: { not: 'browser-session-11' } }
  });
  assert.deepEqual(mcpOAuthRevocation.where, { user_id: 7, revoked_at: null });
  assert.ok(mcpOAuthRevocation.data.revoked_at instanceof Date);
  assert.deepEqual(mcpOAuthCodeDeletion.where, { user_id: 7 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { message: 'Password updated' });
});

test('user route: GET /account/export returns a no-store attachment', async () => {
  const accountExport = {
    format: 'calibrate-account-export',
    version: 7,
    exported_at: '2026-07-11T20:00:00.000Z'
  };
  const router = loadUserRouter({
    prismaStub: { user: {} },
    bcryptStub: {},
    accountLifecycleStub: {
      exportAccountData: async (userId) => {
        assert.equal(userId, 7);
        return accountExport;
      },
      deleteAccountData: async () => false
    }
  });
  const handler = getRouteHandler(router, 'get', '/account/export');
  const res = createRes();

  await handler({ user: { id: 7 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.headers['content-disposition'], /calibrate-account-export-2026-07-11\.json/);
  assert.equal(res.body, accountExport);
});

test('user route: DELETE /account requires and verifies the current password', async () => {
  let deleted = false;
  const router = loadUserRouter({
    prismaStub: {
      user: { findUnique: async () => ({ password_hash: 'stored-hash' }) }
    },
    bcryptStub: { compare: async () => false },
    accountLifecycleStub: {
      exportAccountData: async () => null,
      deleteAccountData: async () => {
        deleted = true;
        return true;
      }
    }
  });
  const handler = getRouteHandler(router, 'delete', '/account');

  const missingRes = createRes();
  await handler({ user: { id: 7 }, body: {} }, missingRes);
  assert.equal(missingRes.statusCode, 400);
  assert.deepEqual(missingRes.body, { message: 'Current password is required' });

  const wrongRes = createRes();
  await handler({ user: { id: 7 }, body: { current_password: 'wrong' } }, wrongRes);
  assert.equal(wrongRes.statusCode, 400);
  assert.deepEqual(wrongRes.body, { message: 'Current password is incorrect' });
  assert.equal(deleted, false);
});

test('user route: DELETE /account deletes data, destroys the request session, and clears the cookie', async () => {
  let deletedUserId = null;
  let sessionDestroyed = false;
  const router = loadUserRouter({
    prismaStub: {
      user: { findUnique: async () => ({ password_hash: 'stored-hash' }) }
    },
    bcryptStub: { compare: async () => true },
    accountLifecycleStub: {
      exportAccountData: async () => null,
      deleteAccountData: async (userId) => {
        deletedUserId = userId;
        return true;
      }
    }
  });
  const handler = getRouteHandler(router, 'delete', '/account');
  const req = {
    user: { id: 7 },
    body: { current_password: 'correct-password' },
    session: {
      destroy: (callback) => {
        sessionDestroyed = true;
        callback();
      }
    }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(deletedUserId, 7);
  assert.equal(sessionDestroyed, true);
  assert.deepEqual(res.clearedCookie, { name: 'cal.sid', options: { path: '/' } });
  assert.equal(res.statusCode, 204);
});

test('user route: PATCH /preferences validates reminder preference booleans', async () => {
  const prismaStub = {
    user: {
      update: async () => {
        throw new Error('should not be called');
      }
    }
  };
  const bcryptStub = {};

  const router = loadUserRouter({ prismaStub, bcryptStub });
  const handler = getRouteHandler(router, 'patch', '/preferences');

  const req = { user: { id: 7 }, body: { reminder_log_weight_enabled: 'yes' } };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid reminder_log_weight_enabled' });
});

test('user route: PATCH /preferences updates reminder preference fields', async () => {
  const updatedUser = {
    id: 7,
    email: 'user@example.com',
    created_at: new Date('2025-01-01T00:00:00Z'),
    weight_unit: 'KG',
    height_unit: 'CM',
    timezone: 'UTC',
    language: 'en',
    reminder_log_weight_enabled: false,
    reminder_log_food_enabled: true,
    haptics_enabled: true,
    date_of_birth: null,
    sex: null,
    height_mm: null,
    activity_level: null,
    profile_image: null,
    profile_image_mime_type: null
  };

  let updateArgs = null;
  const prismaStub = {
    user: {
      update: async (args) => {
        updateArgs = args;
        return updatedUser;
      }
    }
  };
  const bcryptStub = {};

  const router = loadUserRouter({ prismaStub, bcryptStub });
  const handler = getRouteHandler(router, 'patch', '/preferences');

  const req = { user: { id: 7 }, body: { reminder_log_weight_enabled: false } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateArgs.where.id, 7);
  assert.deepEqual(updateArgs.data, { reminder_log_weight_enabled: false });
  assert.equal(res.body.user.reminder_log_weight_enabled, false);
  assert.equal(res.body.user.reminder_log_food_enabled, true);
});

test('user route: PATCH /preferences validates haptics_enabled boolean', async () => {
  const prismaStub = {
    user: {
      update: async () => {
        throw new Error('should not be called');
      }
    }
  };
  const bcryptStub = {};

  const router = loadUserRouter({ prismaStub, bcryptStub });
  const handler = getRouteHandler(router, 'patch', '/preferences');

  const req = { user: { id: 7 }, body: { haptics_enabled: 'on' } };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid haptics_enabled' });
});

test('user route: PATCH /preferences updates haptics_enabled field', async () => {
  const updatedUser = {
    id: 7,
    email: 'user@example.com',
    created_at: new Date('2025-01-01T00:00:00Z'),
    weight_unit: 'KG',
    height_unit: 'CM',
    timezone: 'UTC',
    language: 'en',
    reminder_log_weight_enabled: true,
    reminder_log_food_enabled: true,
    haptics_enabled: false,
    date_of_birth: null,
    sex: null,
    height_mm: null,
    activity_level: null,
    profile_image: null,
    profile_image_mime_type: null
  };

  let updateArgs = null;
  const prismaStub = {
    user: {
      update: async (args) => {
        updateArgs = args;
        return updatedUser;
      }
    }
  };
  const bcryptStub = {};

  const router = loadUserRouter({ prismaStub, bcryptStub });
  const handler = getRouteHandler(router, 'patch', '/preferences');

  const req = { user: { id: 7 }, body: { haptics_enabled: false } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(updateArgs.where.id, 7);
  assert.deepEqual(updateArgs.data, { haptics_enabled: false });
  assert.equal(res.body.user.haptics_enabled, false);
});

test('user route: GET /profile reads the latest goal with deterministic ordering', async () => {
  let goalFindFirstArgs = null;
  let revisionFindFirstArgs = null;
  const dbUser = {
    id: 7,
    timezone: 'UTC',
    date_of_birth: null,
    sex: null,
    height_mm: null,
    activity_level: null,
    weight_unit: 'KG',
    height_unit: 'CM'
  };

  const prismaStub = {
    user: {
      findUnique: async () => dbUser
    },
    goal: {
      findFirst: async (args) => {
        goalFindFirstArgs = args;
        return {
          id: 41, user_id: 7, start_weight_grams: 75_000, target_weight_grams: 70_000,
          target_date: null, daily_deficit: 500, created_at: new Date('2026-01-01T00:00:00.000Z'),
          calorie_plan_review_status: 'CLEAR', calorie_plan_review_reason: null
        };
      }
    },
    caloriePlanRevision: {
      findFirst: async (args) => {
        revisionFindFirstArgs = args;
        return null;
      }
    },
    bodyMetric: {
      findFirst: async () => ({ weight_grams: 70000 })
    }
  };
  const bcryptStub = {};

  const router = loadUserRouter({ prismaStub, bcryptStub });
  const handler = getRouteHandler(router, 'get', '/profile');

  const req = { user: { id: 7 } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(goalFindFirstArgs.orderBy, [{ created_at: 'desc' }, { id: 'desc' }]);
  assert.equal(revisionFindFirstArgs.where.source_goal_id, 41);
  assert.equal(res.body.goal_daily_deficit, 500);
});


test('user route: PATCH /profile fails invalid legacy timezones closed and marks the current goal in the same transaction', async () => {
  let inTransaction = false;
  let goalReview = null;
  let revisionReview = null;
  let staleRecommendations = null;
  const storedUser = {
    id: 7, email: 'owner@example.com', created_at: new Date('2025-01-01T00:00:00.000Z'),
    timezone: 'Not/A_Zone', date_of_birth: new Date('1990-01-01T00:00:00.000Z'), sex: 'MALE',
    height_mm: 1800, activity_level: 'MODERATE', weight_unit: 'KG', height_unit: 'CM', language: 'en',
    reminder_log_weight_enabled: true, reminder_log_food_enabled: true, haptics_enabled: true,
    profile_image: null, profile_image_mime_type: null
  };
  const goal = {
    id: 41, user_id: 7, start_weight_grams: 80_000, target_weight_grams: 70_000, target_date: null,
    daily_deficit: 500, created_at: new Date('2026-01-01T00:00:00.000Z'),
    calorie_plan_review_status: 'CLEAR', calorie_plan_review_reason: null
  };
  const prismaStub = {
    $executeRaw: async () => { assert.equal(inTransaction, true); return 1; },
    user: { findUnique: async () => storedUser, update: async ({ data }) => ({ ...storedUser, ...data }) },
    goal: {
      findFirst: async () => goal,
      update: async ({ data }) => { assert.equal(inTransaction, true); goalReview = data; return { ...goal, ...data }; }
    },
    caloriePlanRevision: {
      findFirst: async () => null,
      updateMany: async ({ data }) => { assert.equal(inTransaction, true); revisionReview = data; return { count: 0 }; }
    },
    calibrationRecommendation: {
      updateMany: async ({ data }) => { assert.equal(inTransaction, true); staleRecommendations = data; return { count: 0 }; }
    },
    $transaction: async (callback) => {
      inTransaction = true;
      try { return await callback(prismaStub); }
      finally { inTransaction = false; }
    }
  };
  const router = loadUserRouter({ prismaStub, bcryptStub: {} });
  const handler = getRouteHandler(router, 'patch', '/profile');
  const res = createRes();

  await handler({ user: { id: 7 }, body: { height_mm: 1810 } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(goalReview, { calorie_plan_review_status: 'REQUIRES_REVIEW', calorie_plan_review_reason: 'TIMEZONE_INVALID' });
  assert.deepEqual(revisionReview, { calorie_plan_review_status: 'REQUIRES_REVIEW', calorie_plan_review_reason: 'PLAN_REVISION_UNSAFE' });
  assert.deepEqual(staleRecommendations, { status: 'STALE' });
});

test('user route: a profile serialization conflict returns a retryable conflict', async () => {
  const { Prisma } = require('@prisma/client');
  const router = loadUserRouter({ prismaStub: {
    $transaction: async () => { throw new Prisma.PrismaClientKnownRequestError('concurrent pace', {
      code: 'P2034', clientVersion: 'test'
    }); }
  }, bcryptStub: {} });
  const res = createRes();
  await getRouteHandler(router, 'patch', '/profile')({ user: { id: 7 }, body: { timezone: 'UTC' } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'PROFILE_PLAN_CHANGED');
  assert.equal(res.body.retryable, true);
});
