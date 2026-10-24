/** @file Regression coverage for routes food: food route: rejects unauthenticated requests via router.use middleware. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
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

function loadFoodRouter({ prismaStub, foodDataStub }) {
  prismaStub.$executeRaw ??= async () => 1;
  prismaStub.user ??= { findUnique: async () => ({ id: 7, timezone: 'UTC' }) };
  prismaStub.dailyCaloriePlan ??= require('./helpers/dailyCaloriePlanStore')();
  prismaStub.foodLog ??= {};
  prismaStub.foodLog.findFirst ??= async () => null;
  const dbPath = require.resolve('../src/config/database');
  const foodDataPath = require.resolve('../src/services/foodData');
  const clientOperationsPath = require.resolve('../src/services/clientOperations');
  const foodRoutePath = require.resolve('../src/routes/food');

  const previousDbModule = require.cache[dbPath];
  const previousFoodDataModule = require.cache[foodDataPath];
  const previousClientOperationsModule = require.cache[clientOperationsPath];

  delete require.cache[foodRoutePath];
  delete require.cache[clientOperationsPath];

  // Mutation routes always append to the sync feed, including legacy clients
  // that have not started sending an idempotency key yet.
  prismaStub.syncChange ??= { create: async () => ({ id: 1n }) };
  prismaStub.foodLogDay ??= {
    findUnique: async ({ where }) => ({
      id: 1,
      local_date: where.user_id_local_date.local_date,
      status: 'OPEN',
      origin: 'USER',
      completed_at: null,
      updated_at: new Date('2025-01-01T12:00:00.000Z')
    })
  };
  prismaStub.$transaction ??= async (callback) => callback(prismaStub);

  stubModule(dbPath, prismaStub);
  stubModule(foodDataPath, foodDataStub);

  const loaded = require('../src/routes/food');

  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];

  if (previousFoodDataModule) require.cache[foodDataPath] = previousFoodDataModule;
  else delete require.cache[foodDataPath];

  if (previousClientOperationsModule) require.cache[clientOperationsPath] = previousClientOperationsModule;
  else delete require.cache[clientOperationsPath];

  return loaded.default ?? loaded;
}

function createRes() {
  return {
    statusCode: 200,
    body: undefined,
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

test('food route: rejects unauthenticated requests via router.use middleware', async () => {
  const router = loadFoodRouter({
    prismaStub: {},
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const isAuthenticated = getIsAuthenticatedMiddleware(router);

  const req = { isAuthenticated: () => false };
  const res = createRes();

  let nextCalled = false;
  await isAuthenticated(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: 'Not authenticated' });
});

test('food route: GET /search requires query or barcode', async () => {
  const router = loadFoodRouter({
    prismaStub: {},
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });

  const handler = getRouteHandler(router, 'get', '/search');
  const req = { query: {}, headers: {} };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Provide a search query or barcode.' });
});

test('food route: GET /search calls provider.searchFoods and returns provider metadata', async () => {
  let receivedRequest = null;

  const providerStub = {
    name: 'openFoodFacts',
    supportsBarcodeLookup: true,
    searchFoods: async (request) => {
      receivedRequest = request;
      return { items: [{ id: '1', source: 'openFoodFacts', description: 'Test', availableMeasures: [] }] };
    }
  };

  const router = loadFoodRouter({
    prismaStub: {},
    foodDataStub: {
      getEnabledFoodDataProviders: () => ({
        primary: { name: 'openFoodFacts', label: 'Open Food Facts', supportsBarcodeLookup: true, ready: true },
        providers: [{ name: 'openFoodFacts', label: 'Open Food Facts', supportsBarcodeLookup: true, ready: true }]
      }),
      getFoodDataProviderByName: (name) => {
        if (name === 'openFoodFacts') return { provider: providerStub };
        return { error: 'unknown provider' };
      }
    }
  });

  const handler = getRouteHandler(router, 'get', '/search');
  const req = {
    query: { q: 'apple', page: '2', pageSize: '10', grams: '50', lc: 'en' },
    headers: { 'accept-language': 'fr-FR,fr;q=0.9' }
  };
  const res = createRes();

  await handler(req, res);

  assert.deepEqual(receivedRequest, {
    query: 'apple',
    barcode: undefined,
    page: 2,
    pageSize: 10,
    quantityInGrams: 50,
    languageCode: 'en'
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'openFoodFacts');
  assert.equal(res.body.supportsBarcodeLookup, true);
  assert.equal(Array.isArray(res.body.items), true);
});

test('food route: GET /search keeps text pagination pinned when a provider returns no matches', async () => {
  const callOrder = [];
  const providerA = {
    name: 'fatsecret',
    supportsBarcodeLookup: true,
    searchFoods: async () => {
      callOrder.push('fatsecret');
      return { items: [] };
    }
  };
  const providerB = {
    name: 'usda',
    supportsBarcodeLookup: true,
    searchFoods: async () => {
      callOrder.push('usda');
      return { items: [{ id: '2', source: 'usda', description: 'Apple', availableMeasures: [] }] };
    }
  };

  const router = loadFoodRouter({
    prismaStub: {},
    foodDataStub: {
      getEnabledFoodDataProviders: () => ({
        primary: { name: 'fatsecret', label: 'FatSecret', supportsBarcodeLookup: true, ready: true },
        providers: [
          { name: 'fatsecret', label: 'FatSecret', supportsBarcodeLookup: true, ready: true },
          { name: 'usda', label: 'USDA FoodData Central', supportsBarcodeLookup: true, ready: true }
        ]
      }),
      getFoodDataProviderByName: (name) => {
        if (name === 'fatsecret') return { provider: providerA };
        if (name === 'usda') return { provider: providerB };
        return { error: 'unknown provider' };
      }
    }
  });

  const handler = getRouteHandler(router, 'get', '/search');
  const req = { query: { q: 'apple', page: '2' }, headers: {} };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'fatsecret');
  assert.equal(res.body.items.length, 0);
  assert.deepEqual(callOrder, ['fatsecret']);
});

test('food route: GET /search falls back to the next provider when text search errors', async () => {
  const failuresBefore = operationCount('food_provider_request', 'failures');
  const successesBefore = operationCount('food_provider_request', 'successes');
  const callOrder = [];
  const providerA = {
    name: 'fatsecret',
    supportsBarcodeLookup: true,
    searchFoods: async () => {
      callOrder.push('fatsecret');
      throw new Error('upstream unavailable');
    }
  };
  const providerB = {
    name: 'usda',
    supportsBarcodeLookup: true,
    searchFoods: async () => {
      callOrder.push('usda');
      return { items: [{ id: '2', source: 'usda', description: 'Apple', availableMeasures: [] }] };
    }
  };

  const router = loadFoodRouter({
    prismaStub: {},
    foodDataStub: {
      getEnabledFoodDataProviders: () => ({
        primary: { name: 'fatsecret', label: 'FatSecret', supportsBarcodeLookup: true, ready: true },
        providers: [
          { name: 'fatsecret', label: 'FatSecret', supportsBarcodeLookup: true, ready: true },
          { name: 'usda', label: 'USDA FoodData Central', supportsBarcodeLookup: true, ready: true }
        ]
      }),
      getFoodDataProviderByName: (name) => {
        if (name === 'fatsecret') return { provider: providerA };
        if (name === 'usda') return { provider: providerB };
        return { error: 'unknown provider' };
      }
    }
  });

  const handler = getRouteHandler(router, 'get', '/search');
  const req = { query: { q: 'apple' }, headers: {} };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'usda');
  assert.equal(res.body.items.length, 1);
  assert.deepEqual(callOrder, ['fatsecret', 'usda']);
  assert.equal(operationCount('food_provider_request', 'failures'), failuresBefore + 1);
  assert.equal(operationCount('food_provider_request', 'successes'), successesBefore + 1);
});

test('food route: GET /search falls back to the next provider for barcode lookups', async () => {
  const callOrder = [];
  const providerA = {
    name: 'fatsecret',
    supportsBarcodeLookup: true,
    searchFoods: async () => {
      callOrder.push('fatsecret');
      return { items: [] };
    }
  };
  const providerB = {
    name: 'openFoodFacts',
    supportsBarcodeLookup: true,
    searchFoods: async () => {
      callOrder.push('openFoodFacts');
      return { items: [{ id: '1', source: 'openFoodFacts', description: 'Test', availableMeasures: [] }] };
    }
  };

  const router = loadFoodRouter({
    prismaStub: {},
    foodDataStub: {
      getFoodDataProvider: () => {
        throw new Error('getFoodDataProvider should not be called for barcode searches');
      },
      getEnabledFoodDataProviders: () => ({
        primary: { name: 'fatsecret', label: 'FatSecret', supportsBarcodeLookup: true, ready: true },
        providers: [
          { name: 'fatsecret', label: 'FatSecret', supportsBarcodeLookup: true, ready: true },
          { name: 'openFoodFacts', label: 'Open Food Facts', supportsBarcodeLookup: true, ready: true }
        ]
      }),
      getFoodDataProviderByName: (name) => {
        if (name === 'fatsecret') return { provider: providerA };
        if (name === 'openFoodFacts') return { provider: providerB };
        return { error: 'unknown provider' };
      }
    }
  });

  const handler = getRouteHandler(router, 'get', '/search');
  const req = { query: { barcode: '1234567890123' }, headers: {} };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'openFoodFacts');
  assert.equal(res.body.supportsBarcodeLookup, true);
  assert.equal(res.body.items.length, 1);
  assert.deepEqual(callOrder, ['fatsecret', 'openFoodFacts']);
});

test('food route: GET /search returns empty results when barcode providers return no matches', async () => {
  const providerA = {
    name: 'fatsecret',
    supportsBarcodeLookup: true,
    searchFoods: async () => ({ items: [] })
  };
  const providerB = {
    name: 'openFoodFacts',
    supportsBarcodeLookup: true,
    searchFoods: async () => ({ items: [] })
  };

  const router = loadFoodRouter({
    prismaStub: {},
    foodDataStub: {
      getFoodDataProvider: () => {
        throw new Error('getFoodDataProvider should not be called for barcode searches');
      },
      getEnabledFoodDataProviders: () => ({
        primary: { name: 'fatsecret', label: 'FatSecret', supportsBarcodeLookup: true, ready: true },
        providers: [
          { name: 'fatsecret', label: 'FatSecret', supportsBarcodeLookup: true, ready: true },
          { name: 'openFoodFacts', label: 'Open Food Facts', supportsBarcodeLookup: true, ready: true }
        ]
      }),
      getFoodDataProviderByName: (name) => {
        if (name === 'fatsecret') return { provider: providerA };
        if (name === 'openFoodFacts') return { provider: providerB };
        return { error: 'unknown provider' };
      }
    }
  });

  const handler = getRouteHandler(router, 'get', '/search');
  const req = { query: { barcode: '1234567890123' }, headers: {} };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items, []);
});

test('food route: GET /search skips providers that disable barcode lookup at runtime', async () => {
  const callOrder = [];
  const providerA = {
    name: 'fatsecret',
    supportsBarcodeLookup: true,
    searchFoods: async () => {
      callOrder.push('fatsecret');
      providerA.supportsBarcodeLookup = false;
      return { items: [{ id: '1', source: 'fatsecret', description: 'Fallback', availableMeasures: [] }] };
    }
  };
  const providerB = {
    name: 'openFoodFacts',
    supportsBarcodeLookup: true,
    searchFoods: async () => {
      callOrder.push('openFoodFacts');
      return { items: [{ id: '2', source: 'openFoodFacts', description: 'Barcode', availableMeasures: [] }] };
    }
  };

  const router = loadFoodRouter({
    prismaStub: {},
    foodDataStub: {
      getFoodDataProvider: () => {
        throw new Error('getFoodDataProvider should not be called for barcode searches');
      },
      getEnabledFoodDataProviders: () => ({
        primary: { name: 'fatsecret', label: 'FatSecret', supportsBarcodeLookup: true, ready: true },
        providers: [
          { name: 'fatsecret', label: 'FatSecret', supportsBarcodeLookup: true, ready: true },
          { name: 'openFoodFacts', label: 'Open Food Facts', supportsBarcodeLookup: true, ready: true }
        ]
      }),
      getFoodDataProviderByName: (name) => {
        if (name === 'fatsecret') return { provider: providerA };
        if (name === 'openFoodFacts') return { provider: providerB };
        return { error: 'unknown provider' };
      }
    }
  });

  const handler = getRouteHandler(router, 'get', '/search');
  const req = { query: { barcode: '1234567890123' }, headers: {} };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.provider, 'openFoodFacts');
  assert.equal(res.body.items.length, 1);
  assert.deepEqual(callOrder, ['fatsecret', 'openFoodFacts']);
});

test('food route: GET /search returns 500 when all barcode providers fail', async () => {
  const providerA = {
    name: 'fatsecret',
    supportsBarcodeLookup: true,
    searchFoods: async () => {
      throw new Error('FatSecret down');
    }
  };
  const providerB = {
    name: 'openFoodFacts',
    supportsBarcodeLookup: true,
    searchFoods: async () => {
      throw new Error('Open Food Facts down');
    }
  };

  const router = loadFoodRouter({
    prismaStub: {},
    foodDataStub: {
      getFoodDataProvider: () => {
        throw new Error('getFoodDataProvider should not be called for barcode searches');
      },
      getEnabledFoodDataProviders: () => ({
        primary: { name: 'fatsecret', label: 'FatSecret', supportsBarcodeLookup: true, ready: true },
        providers: [
          { name: 'fatsecret', label: 'FatSecret', supportsBarcodeLookup: true, ready: true },
          { name: 'openFoodFacts', label: 'Open Food Facts', supportsBarcodeLookup: true, ready: true }
        ]
      }),
      getFoodDataProviderByName: (name) => {
        if (name === 'fatsecret') return { provider: providerA };
        if (name === 'openFoodFacts') return { provider: providerB };
        return { error: 'unknown provider' };
      }
    }
  });

  const handler = getRouteHandler(router, 'get', '/search');
  const req = { query: { barcode: '1234567890123' }, headers: {} };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { message: 'Unable to search foods right now.' });
});

test('food route: GET /recent returns deduped recent food suggestions', async () => {
  const rows = [
    {
      id: 3,
      name: 'Greek yogurt',
      meal_period: 'BREAKFAST',
      calories: 120,
      my_food_id: null,
      servings_consumed: 1,
      serving_size_quantity_snapshot: 1,
      serving_unit_label_snapshot: 'cup',
      calories_per_serving_snapshot: 120,
      external_source: 'openFoodFacts',
      external_id: 'yogurt-1',
      brand_snapshot: 'Brand',
      locale_snapshot: null,
      barcode_snapshot: null,
      measure_label_snapshot: 'cup',
      grams_per_measure_snapshot: 170,
      measure_quantity_snapshot: 1,
      grams_total_snapshot: 170,
      created_at: new Date('2025-01-03T12:00:00Z')
    },
    {
      id: 2,
      name: 'Greek yogurt',
      meal_period: 'BREAKFAST',
      calories: 120,
      my_food_id: null,
      servings_consumed: 1,
      serving_size_quantity_snapshot: 1,
      serving_unit_label_snapshot: 'cup',
      calories_per_serving_snapshot: 120,
      external_source: 'openFoodFacts',
      external_id: 'yogurt-1',
      brand_snapshot: 'Brand',
      locale_snapshot: null,
      barcode_snapshot: null,
      measure_label_snapshot: 'cup',
      grams_per_measure_snapshot: 170,
      measure_quantity_snapshot: 1,
      grams_total_snapshot: 170,
      created_at: new Date('2025-01-02T12:00:00Z')
    }
  ];

  const prismaStub = {
    foodLog: {
      findMany: async ({ where, take }) => {
        assert.deepEqual(where, { user_id: 7 });
        assert.equal(take, 200);
        return rows;
      }
    }
  };

  const router = loadFoodRouter({
    prismaStub,
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'get', '/recent');

  const req = { user: { id: 7 }, query: {} };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].name, 'Greek yogurt');
  assert.equal(res.body.items[0].times_logged, 2);
  assert.equal(res.body.items[0].external_source, 'openFoodFacts');
});

test('food route: GET /recent prioritizes foods frequently logged for the selected meal', async () => {
  const rows = [
    {
      id: 4,
      name: 'Dinner favorite',
      meal_period: 'DINNER',
      calories: 500,
      my_food_id: 4,
      created_at: new Date('2026-08-04T19:00:00Z')
    },
    {
      id: 3,
      name: 'Oatmeal',
      meal_period: 'BREAKFAST',
      calories: 280,
      my_food_id: 1,
      created_at: new Date('2026-08-03T08:00:00Z')
    },
    {
      id: 2,
      name: 'Smoothie',
      meal_period: 'BREAKFAST',
      calories: 240,
      my_food_id: 2,
      created_at: new Date('2026-08-02T08:00:00Z')
    },
    {
      id: 1,
      name: 'Oatmeal',
      meal_period: 'BREAKFAST',
      calories: 280,
      my_food_id: 1,
      created_at: new Date('2026-08-01T08:00:00Z')
    }
  ];
  const prismaStub = {
    foodLog: {
      findMany: async () => rows
    }
  };
  const router = loadFoodRouter({
    prismaStub,
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'get', '/recent');
  const req = {
    user: { id: 7 },
    query: { meal_period: 'BREAKFAST', limit: '2' }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items.map((item) => item.name), ['Oatmeal', 'Smoothie']);
  assert.equal(res.body.items[0].times_logged, 2);
});

test('food route: GET /recent rejects an invalid meal period', async () => {
  const prismaStub = {
    foodLog: {
      findMany: async () => {
        throw new Error('should not be called');
      }
    }
  };
  const router = loadFoodRouter({
    prismaStub,
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'get', '/recent');
  const req = { user: { id: 7 }, query: { meal_period: 'BRUNCH' } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid meal period' });
});

test('food route: GET / validates local_date/date query params', async () => {
  const prismaStub = {
    foodLog: {
      findMany: async () => {
        throw new Error('should not be called');
      }
    }
  };

  const router = loadFoodRouter({
    prismaStub,
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'get', '/');

  const req = { user: { id: 7 }, query: { date: 'not-a-date' } };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid date' });
});

test('food route: GET / passes local_date filter through to Prisma', async () => {
  let receivedWhere = null;
  const prismaStub = {
    foodLog: {
      findMany: async ({ where }) => {
        receivedWhere = where;
        return [{ id: 1, name: 'Test' }];
      }
    }
  };

  const router = loadFoodRouter({
    prismaStub,
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'get', '/');

  const req = { user: { id: 7 }, query: { local_date: '2025-01-01' } };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [{ id: 1, name: 'Test' }]);

  assert.equal(receivedWhere.user_id, 7);
  assert.equal(receivedWhere.local_date.toISOString(), '2025-01-01T00:00:00.000Z');
});

test('food route: POST / creates a manual log after validating inputs', async () => {
  let receivedData = null;
  const createdLog = { id: 1, user_id: 7, name: 'Apple', calories: 12 };

  const prismaStub = {
    myFood: {},
    foodLog: {
      create: async ({ data }) => {
        receivedData = data;
        return createdLog;
      }
    }
  };

  const router = loadFoodRouter({
    prismaStub,
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'post', '/');

  const req = {
    user: { id: 7, timezone: 'UTC' },
    body: { meal_period: 'BREAKFAST', name: '  Apple ', calories: '12.4', date: '2025-01-01' }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, createdLog);
  assert.equal(receivedData.user_id, 7);
  assert.equal(receivedData.name, 'Apple');
  assert.equal(receivedData.calories, 12);
  assert.equal(receivedData.meal_period, 'BREAKFAST');
});

test('food route: POST / rejects writes when the canonical day is paused', async () => {
  let createCalled = false;
  const prismaStub = {
    foodLogDay: {
      findUnique: async ({ where }) => ({
        id: 8,
        local_date: where.user_id_local_date.local_date,
        status: 'PAUSED',
        origin: 'PAUSE',
        completed_at: null,
        updated_at: new Date('2025-01-01T12:00:00.000Z')
      })
    },
    foodLog: {
      create: async () => {
        createCalled = true;
        throw new Error('Paused day must not write');
      }
    }
  };
  const router = loadFoodRouter({
    prismaStub,
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'post', '/');
  const req = {
    user: { id: 7, timezone: 'UTC' },
    body: { meal_period: 'BREAKFAST', name: 'Apple', calories: 12, date: '2025-01-01' }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'FOOD_DAY_NOT_OPEN');
  assert.equal(res.body.retryable, false);
  assert.equal(res.body.food_day.status, 'PAUSED');
  assert.equal(createCalled, false);
});

test('food route: POST / stores external serving snapshots for search-backed logs', async () => {
  let receivedData = null;
  const createdLog = { id: 1, user_id: 7, name: 'Yogurt', calories: 180 };

  const prismaStub = {
    myFood: {},
    foodLog: {
      create: async ({ data }) => {
        receivedData = data;
        return createdLog;
      }
    }
  };

  const router = loadFoodRouter({
    prismaStub,
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'post', '/');

  const req = {
    user: { id: 7, timezone: 'UTC' },
    body: {
      meal_period: 'LUNCH',
      name: 'Yogurt',
      calories: 180,
      servings_consumed: 1.5,
      serving_size_quantity_snapshot: 1,
      serving_unit_label_snapshot: 'cup',
      external_source: 'openFoodFacts',
      external_id: 'abc',
      brand: 'Brand',
      measure_label: 'cup',
      grams_per_measure_snapshot: 170,
      grams_total_snapshot: 255,
      date: '2025-01-01'
    }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, createdLog);
  assert.equal(receivedData.servings_consumed, 1.5);
  assert.equal(receivedData.serving_unit_label_snapshot, 'cup');
  assert.equal(receivedData.calories_per_serving_snapshot, 120);
  assert.equal(receivedData.external_source, 'openFoodFacts');
  assert.equal(receivedData.external_id, 'abc');
  assert.equal(receivedData.brand_snapshot, 'Brand');
  assert.equal(receivedData.measure_label_snapshot, 'cup');
  assert.equal(receivedData.grams_total_snapshot, 255);
});

test('food route: POST / can create a my_food-backed log with snapshots', async () => {
  const myFoodRow = {
    id: 123,
    user_id: 7,
    name: 'Granola bar',
    serving_size_quantity: 1,
    serving_unit_label: 'bar',
    calories_per_serving: 100
  };

  let receivedCreateData = null;
  const createdLog = { id: 9, user_id: 7, name: 'Granola bar', calories: 150 };

  const prismaStub = {
    myFood: {
      findFirst: async () => myFoodRow
    },
    foodLog: {
      create: async ({ data }) => {
        receivedCreateData = data;
        return createdLog;
      }
    }
  };

  const router = loadFoodRouter({
    prismaStub,
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'post', '/');

  const req = {
    user: { id: 7, timezone: 'UTC' },
    body: { meal_period: 'LUNCH', my_food_id: '123', servings_consumed: '1.5', date: '2025-01-01' }
  };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, createdLog);

  assert.equal(receivedCreateData.my_food_id, 123);
  assert.equal(receivedCreateData.servings_consumed, 1.5);
  assert.equal(receivedCreateData.calories, 150);
  assert.equal(receivedCreateData.calories_per_serving_snapshot, 100);
});

test('food route: POST /copy requires a valid operation ID and local-date payload', async () => {
  const router = loadFoodRouter({
    prismaStub: {},
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'post', '/copy');
  const res = createRes();

  await handler({
    user: { id: 7, timezone: 'America/Los_Angeles' },
    body: { source_date: '2026-08-08', target_date: '2026-08-09' }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    message: 'Invalid operation_id',
    code: 'INVALID_FOOD_COPY',
    retryable: false
  });
});

test('food route: POST /copy executes the owned copy in one idempotent transaction', async () => {
  let sourceWhere;
  let createdData;
  let operationReceipt;
  const source = {
    id: 41,
    user_id: 7,
    my_food_id: null,
    date: new Date('2026-08-08T12:00:00.000Z'),
    local_date: new Date('2026-08-08T00:00:00.000Z'),
    meal_period: 'LUNCH',
    name: 'Snapshot lunch',
    calories: 410,
    servings_consumed: 1,
    serving_size_quantity_snapshot: 1,
    serving_unit_label_snapshot: 'bowl',
    calories_per_serving_snapshot: 410,
    external_source: null,
    external_id: null,
    brand_snapshot: null,
    locale_snapshot: null,
    barcode_snapshot: null,
    measure_label_snapshot: null,
    grams_per_measure_snapshot: null,
    measure_quantity_snapshot: null,
    grams_total_snapshot: null,
    created_at: new Date('2026-08-08T12:00:00.000Z')
  };
  const prismaStub = {
    clientOperation: {
      create: async ({ data }) => {
        operationReceipt = { ...data, response_status: null, response_body: null, completed_at: null };
        return operationReceipt;
      },
      update: async ({ data }) => {
        operationReceipt = { ...operationReceipt, ...data };
        return operationReceipt;
      },
      findUnique: async () => operationReceipt
    },
    foodLog: {
      findMany: async ({ where }) => {
        sourceWhere = where;
        return [source];
      },
      create: async ({ data }) => {
        createdData = data;
        return { id: 42, created_at: new Date('2026-08-09T12:00:00.000Z'), ...data };
      }
    }
  };
  const router = loadFoodRouter({
    prismaStub,
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'post', '/copy');
  const res = createRes();

  await handler({
    user: { id: 7, timezone: 'America/Los_Angeles' },
    body: {
      operation_id: 'food-copy-route-001',
      source_date: '2026-08-08',
      target_date: '2026-08-09',
      meal_mappings: [{ source_meal_period: 'LUNCH', target_meal_period: 'DINNER' }]
    }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.operation_id, 'food-copy-route-001');
  assert.equal(res.body.copied_count, 1);
  assert.equal(res.body.food_logs[0].meal_period, 'DINNER');
  assert.deepEqual(sourceWhere, {
    user_id: 7,
    local_date: new Date('2026-08-08T00:00:00.000Z'),
    meal_period: { in: ['LUNCH'] }
  });
  assert.equal(createdData.user_id, 7);
  assert.equal(operationReceipt.operation_kind, 'food_log.copy');
  assert.equal(operationReceipt.response_status, 200);
});

test('food route: PATCH /:id validates and computes updateData', async () => {
  const existingRow = {
    local_date: new Date('2025-01-01Z'),
    id: 1,
    user_id: 7,
    calories_per_serving_snapshot: 110,
    servings_consumed: 1
  };

  let receivedUpdateData = null;
  let receivedOwnershipLookup = null;
  const updatedRow = { id: 1, user_id: 7, calories: 220, servings_consumed: 2 };

  const prismaStub = {
    foodLog: {
      findFirst: async (args) => {
        receivedOwnershipLookup = args;
        return existingRow;
      },
      update: async ({ data }) => {
        receivedUpdateData = data;
        return updatedRow;
      }
    }
  };

  const router = loadFoodRouter({
    prismaStub,
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'patch', '/:id');

  const req = { user: { id: 7 }, params: { id: '1' }, body: { servings_consumed: 2 } };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, updatedRow);
  assert.deepEqual(receivedOwnershipLookup.where, { id: 1, user_id: 7 });
  assert.deepEqual(receivedUpdateData, { servings_consumed: 2, calories: 220 });
});

test('food route: DELETE /:id validates ids and returns 204 on delete', async () => {
  let receivedDeleteWhere = null;
  const prismaStub = {
    foodLog: {
      deleteMany: async ({ where }) => {
        receivedDeleteWhere = where;
        return { count: 1 };
      }
    }
  };

  const router = loadFoodRouter({
    prismaStub,
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'delete', '/:id');

  const res = createRes();
  await handler({ user: { id: 7 }, params: { id: '123' } }, res);
  assert.equal(res.statusCode, 204);
  assert.deepEqual(receivedDeleteWhere, { id: 123, user_id: 7 });
});

test('food route: DELETE /:id treats an already-absent owned log as idempotent success', async () => {
  let syncChanges = 0;
  const prismaStub = {
    foodLog: {
      deleteMany: async () => ({ count: 0 })
    },
    syncChange: {
      create: async () => {
        syncChanges += 1;
        return { id: 1n };
      }
    }
  };

  const router = loadFoodRouter({
    prismaStub,
    foodDataStub: { getFoodDataProvider: () => ({}) }
  });
  const handler = getRouteHandler(router, 'delete', '/:id');
  const res = createRes();

  await handler({ user: { id: 7 }, params: { id: '123' } }, res);

  assert.equal(res.statusCode, 204);
  assert.equal(syncChanges, 0);
});
