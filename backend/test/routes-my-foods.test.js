/** @file Regression coverage for routes my foods: myFoods route: rejects unauthenticated requests via router.use middleware. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadMyFoodsRouter(prismaStub) {
  const dbPath = require.resolve('../src/config/database');
  const routePath = require.resolve('../src/routes/myFoods');

  const previousDbModule = require.cache[dbPath];
  delete require.cache[routePath];

  stubModule(dbPath, prismaStub);
  const loaded = require('../src/routes/myFoods');

  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];

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
    end() {
      this.ended = true;
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

test('myFoods route: rejects unauthenticated requests via router.use middleware', async () => {
  const router = loadMyFoodsRouter({});
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

test('myFoods route: GET / builds filters from q + type', async () => {
  let receivedWhere = null;
  let receivedOrderBy = null;
  const prismaStub = {
    myFood: {
      findMany: async ({ where, orderBy }) => {
        receivedWhere = where;
        receivedOrderBy = orderBy;
        return [{ id: 1, name: 'Apple' }];
      }
    }
  };

  const router = loadMyFoodsRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/');

  const req = { user: { id: 7 }, query: { q: 'app', type: 'food' } };
  const res = createRes();

  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [{ id: 1, name: 'Apple' }]);

  assert.deepEqual(receivedWhere, {
    user_id: 7,
    name: { contains: 'app', mode: 'insensitive' },
    type: 'FOOD'
  });
  assert.deepEqual(receivedOrderBy, [
    { is_pinned: 'desc' },
    { name: 'asc' },
    { id: 'asc' }
  ]);
});

test('myFoods route: GET /library returns a paged envelope without changing the legacy array route', async () => {
  const rows = [
    {
      id: 1,
      type: 'FOOD',
      name: 'Apple',
      serving_size_quantity: 1,
      serving_unit_label: 'item',
      calories_per_serving: 95,
      is_pinned: true,
      recipe_total_calories: null,
      yield_servings: null,
      normalized_name: 'apple',
      snapshot_max_id: 2
    },
    {
      id: 2,
      type: 'RECIPE',
      name: 'Bowl',
      serving_size_quantity: 1,
      serving_unit_label: 'bowl',
      calories_per_serving: 400,
      is_pinned: false,
      recipe_total_calories: 800,
      yield_servings: 2,
      normalized_name: 'bowl',
      snapshot_max_id: 2
    }
  ];
  let receivedQuery = null;
  const prismaStub = {
    $queryRaw: async (query) => {
      receivedQuery = query;
      return rows;
    }
  };
  const router = loadMyFoodsRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/library');
  const res = createRes();

  await handler({ user: { id: 7 }, query: { q: '  app  ', type: 'food', limit: '1' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].name, 'Apple');
  assert.equal('normalized_name' in res.body.items[0], false);
  assert.equal('snapshot_max_id' in res.body.items[0], false);
  assert.equal(typeof res.body.next_cursor, 'string');
  assert.match(receivedQuery.sql, /WHERE "user_id" = \?/);
  assert.match(receivedQuery.sql, /ORDER BY "is_pinned" DESC, LOWER\("name"\) ASC, "id" ASC/);
  assert.deepEqual(receivedQuery.values, [7, 'app', 'FOOD', 2]);
});

test('myFoods route: GET /library rejects invalid filters, limits, and cursors', async () => {
  const router = loadMyFoodsRouter({ $queryRaw: async () => [] });
  const handler = getRouteHandler(router, 'get', '/library');
  const cases = [
    [{ type: 'meal' }, 'type must be FOOD or RECIPE'],
    [{ limit: '0' }, 'limit must be an integer from 1 to 100'],
    [{ limit: '101' }, 'limit must be an integer from 1 to 100'],
    [{ q: 'x'.repeat(121) }, 'q must be at most 120 characters'],
    [{ cursor: 'not.a.cursor' }, 'Invalid cursor']
  ];

  for (const [query, message] of cases) {
    const res = createRes();
    await handler({ user: { id: 7 }, query }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { message });
  }
});

test('myFoods route: GET /library cursors are opaque, filter-bound, and advance without overlap', async () => {
  const allRows = [
    { id: 4, name: 'apple', is_pinned: true },
    { id: 8, name: 'Apple', is_pinned: true },
    { id: 3, name: 'banana', is_pinned: true },
    { id: 1, name: 'apple', is_pinned: false }
  ].map((item) => ({
    type: 'FOOD',
    serving_size_quantity: 1,
    serving_unit_label: 'item',
    calories_per_serving: 10,
    recipe_total_calories: null,
    yield_servings: null,
    normalized_name: item.name.toLowerCase(),
    snapshot_max_id: 8,
    ...item
  }));
  const receivedQueries = [];
  const prismaStub = {
    $queryRaw: async (query) => {
      receivedQueries.push(query);
      return receivedQueries.length === 1 ? allRows.slice(0, 3) : allRows.slice(2);
    }
  };
  const handler = getRouteHandler(loadMyFoodsRouter(prismaStub), 'get', '/library');
  const first = createRes();
  await handler({ user: { id: 7 }, query: { limit: '2' } }, first);

  assert.deepEqual(first.body.items.map((item) => item.id), [4, 8]);
  assert.match(first.body.next_cursor, /^[A-Za-z0-9_-]+$/);

  const second = createRes();
  await handler({ user: { id: 7 }, query: { limit: '2', cursor: first.body.next_cursor } }, second);
  assert.deepEqual(second.body.items.map((item) => item.id), [3, 1]);
  assert.equal(second.body.next_cursor, null);
  assert.match(receivedQueries[1].sql, /"id" <= \?/);
  assert.match(receivedQueries[1].sql, /LOWER\("name"\) > \?/);
  assert.match(receivedQueries[1].sql, /OR "is_pinned" = false/);
  assert.deepEqual(receivedQueries[1].values, [7, 8, true, 'apple', 'apple', 8, 3]);

  const mismatchedFilter = createRes();
  await handler({ user: { id: 7 }, query: { limit: '2', type: 'RECIPE', cursor: first.body.next_cursor } }, mismatchedFilter);
  assert.equal(mismatchedFilter.statusCode, 400);
  assert.deepEqual(mismatchedFilter.body, { message: 'Invalid cursor' });
});

test('myFoods route: PATCH /:id/pin validates id and boolean state', async () => {
  const router = loadMyFoodsRouter({ myFood: {} });
  const handler = getRouteHandler(router, 'patch', '/:id/pin');

  const invalidIdRes = createRes();
  await handler({ user: { id: 7 }, params: { id: 'bad' }, body: { is_pinned: true } }, invalidIdRes);
  assert.equal(invalidIdRes.statusCode, 400);
  assert.deepEqual(invalidIdRes.body, { message: 'Invalid my food id' });

  const invalidStateRes = createRes();
  await handler({ user: { id: 7 }, params: { id: '12' }, body: { is_pinned: 'true' } }, invalidStateRes);
  assert.equal(invalidStateRes.statusCode, 400);
  assert.deepEqual(invalidStateRes.body, { message: 'is_pinned must be a boolean' });
});

test('myFoods route: PATCH /:id/pin scopes writes to the authenticated user', async () => {
  let receivedUpdate = null;
  let receivedRead = null;
  const updated = { id: 12, user_id: 7, name: 'Oats', is_pinned: true };
  const prismaStub = {
    myFood: {
      updateMany: async (args) => {
        receivedUpdate = args;
        return { count: 1 };
      },
      findFirst: async (args) => {
        receivedRead = args;
        return updated;
      }
    }
  };
  const router = loadMyFoodsRouter(prismaStub);
  const handler = getRouteHandler(router, 'patch', '/:id/pin');
  const res = createRes();

  await handler({ user: { id: 7 }, params: { id: '12' }, body: { is_pinned: true } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, updated);
  assert.deepEqual(receivedUpdate, {
    where: { id: 12, user_id: 7 },
    data: { is_pinned: true }
  });
  assert.deepEqual(receivedRead, { where: { id: 12, user_id: 7 } });
});

test('myFoods route: PATCH /:id/pin returns the same 404 for missing or other-user items', async () => {
  const prismaStub = {
    myFood: {
      updateMany: async () => ({ count: 0 })
    }
  };
  const router = loadMyFoodsRouter(prismaStub);
  const handler = getRouteHandler(router, 'patch', '/:id/pin');
  const res = createRes();

  await handler({ user: { id: 7 }, params: { id: '12' }, body: { is_pinned: false } }, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: 'My food not found' });
});

test('myFoods route: GET /:id validates ids and returns 404 when missing', async () => {
  const prismaStub = {
    myFood: {
      findFirst: async () => null
    }
  };

  const router = loadMyFoodsRouter(prismaStub);
  const handler = getRouteHandler(router, 'get', '/:id');

  const invalidRes = createRes();
  await handler({ user: { id: 7 }, params: { id: 'abc' } }, invalidRes);
  assert.equal(invalidRes.statusCode, 400);
  assert.deepEqual(invalidRes.body, { message: 'Invalid my food id' });

  const missingRes = createRes();
  await handler({ user: { id: 7 }, params: { id: '123' } }, missingRes);
  assert.equal(missingRes.statusCode, 404);
  assert.deepEqual(missingRes.body, { message: 'My food not found' });
});

test('myFoods route: POST /foods validates inputs', async () => {
  const router = loadMyFoodsRouter({ myFood: {} });
  const handler = getRouteHandler(router, 'post', '/foods');

  const res = createRes();
  await handler({ user: { id: 7 }, body: { name: '', serving_size_quantity: 1, serving_unit_label: 'g', calories_per_serving: 10 } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid name' });
});

test('myFoods route: POST /recipes validates ingredients array', async () => {
  const router = loadMyFoodsRouter({ myFood: {}, $transaction: async () => ({}) });
  const handler = getRouteHandler(router, 'post', '/recipes');

  const res = createRes();
  await handler(
    {
      user: { id: 7 },
      body: {
        name: 'Recipe',
        serving_size_quantity: 1,
        serving_unit_label: 'serving',
        yield_servings: 2,
        ingredients: []
      }
    },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Recipe must include at least one ingredient' });
});

test('myFoods route: POST /recipes maps validation errors thrown in the transaction', async () => {
  const prismaStub = {
    $transaction: async (fn) => fn({ myFood: {}, recipeIngredient: {} })
  };

  const router = loadMyFoodsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/recipes');

  const res = createRes();
  await handler(
    {
      user: { id: 7 },
      body: {
        name: 'Recipe',
        serving_size_quantity: 1,
        serving_unit_label: 'serving',
        yield_servings: 2,
        ingredients: [{ source: 'BAD' }]
      }
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid ingredient source' });
});

test('myFoods route: POST /recipes returns 404 when a MY_FOOD ingredient is missing', async () => {
  const txStub = {
    myFood: { findMany: async () => [] },
    recipeIngredient: { createMany: async () => {} }
  };

  const prismaStub = {
    $transaction: async (fn) => fn(txStub)
  };

  const router = loadMyFoodsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/recipes');

  const res = createRes();
  await handler(
    {
      user: { id: 7 },
      body: {
        name: 'Recipe',
        serving_size_quantity: 1,
        serving_unit_label: 'serving',
        yield_servings: 2,
        ingredients: [{ source: 'MY_FOOD', my_food_id: 1, quantity_servings: 1 }]
      }
    },
    res
  );

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: 'Ingredient my food not found' });
});

test('myFoods route: POST /recipes batches owned MY_FOOD ingredient lookup', async () => {
  let findManyCalls = 0;
  let receivedWhere = null;
  let ingredientData = null;
  const txStub = {
    myFood: {
      findMany: async ({ where }) => {
        findManyCalls += 1;
        receivedWhere = where;
        return [
          { id: 1, name: 'Oats', calories_per_serving: 150, serving_size_quantity: 1, serving_unit_label: 'cup' },
          { id: 2, name: 'Milk', calories_per_serving: 90, serving_size_quantity: 1, serving_unit_label: 'cup' }
        ];
      },
      create: async ({ data }) => ({ id: 55, ...data })
    },
    recipeIngredient: {
      createMany: async ({ data }) => { ingredientData = data; }
    }
  };
  const handler = getRouteHandler(loadMyFoodsRouter({
    $transaction: async (fn) => fn(txStub)
  }), 'post', '/recipes');
  const res = createRes();

  await handler({
    user: { id: 7 },
    body: {
      name: 'Breakfast',
      serving_size_quantity: 1,
      serving_unit_label: 'serving',
      yield_servings: 1,
      ingredients: [
        { source: 'MY_FOOD', my_food_id: 1, quantity_servings: 2 },
        { source: 'MY_FOOD', my_food_id: 2, quantity_servings: 1 }
      ]
    }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(findManyCalls, 1);
  assert.deepEqual(receivedWhere, { id: { in: [1, 2] }, user_id: 7, type: 'FOOD' });
  assert.deepEqual(ingredientData.map((row) => row.name_snapshot), ['Oats', 'Milk']);
  assert.deepEqual(ingredientData.map((row) => row.calories_total_snapshot), [300, 90]);
});
test('myFoods route: POST /recipes creates a recipe and ingredient snapshots', async () => {
  let receivedRecipeData = null;
  let receivedIngredientData = null;

  const txStub = {
    myFood: {
      create: async ({ data }) => {
        receivedRecipeData = data;
        return { id: 55, ...data };
      },
      findFirst: async () => null
    },
    recipeIngredient: {
      createMany: async ({ data }) => {
        receivedIngredientData = data;
      }
    }
  };

  const prismaStub = {
    $transaction: async (fn) => fn(txStub)
  };

  const router = loadMyFoodsRouter(prismaStub);
  const handler = getRouteHandler(router, 'post', '/recipes');

  const req = {
    user: { id: 7 },
    body: {
      name: '  Pasta  ',
      serving_size_quantity: 1,
      serving_unit_label: 'serving',
      yield_servings: 2,
      ingredients: [{ source: 'EXTERNAL', name: ' Tomato  sauce ', calories_total: 100, brand: '  Brand ' }]
    }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, 55);
  assert.equal(receivedRecipeData.user_id, 7);
  assert.equal(receivedRecipeData.type, 'RECIPE');
  assert.equal(receivedRecipeData.name, 'Pasta');
  assert.equal(receivedRecipeData.recipe_total_calories, 100);
  assert.equal(receivedRecipeData.yield_servings, 2);
  assert.equal(receivedRecipeData.calories_per_serving, 50);

  assert.ok(Array.isArray(receivedIngredientData));
  assert.equal(receivedIngredientData.length, 1);
  assert.equal(receivedIngredientData[0].recipe_id, 55);
  assert.equal(receivedIngredientData[0].source, 'EXTERNAL');
  assert.equal(receivedIngredientData[0].name_snapshot, 'Tomato sauce');
  assert.equal(receivedIngredientData[0].brand_snapshot, 'Brand');
  assert.equal(receivedIngredientData[0].calories_total_snapshot, 100);
});

test('myFoods route: POST /recipes/from-food-logs validates its payload before opening a transaction', async () => {
  let transactionCalls = 0;
  const router = loadMyFoodsRouter({
    $transaction: async () => {
      transactionCalls += 1;
    }
  });
  const handler = getRouteHandler(router, 'post', '/recipes/from-food-logs');
  const cases = [
    [{ name: '', yield_servings: 1, food_log_ids: [1] }, 'Invalid name'],
    [{ name: 'Meal', yield_servings: 0, food_log_ids: [1] }, 'Invalid yield servings'],
    [{ name: 'Meal', yield_servings: 1, food_log_ids: [] }, 'Recipe must include at least one food log'],
    [{ name: 'Meal', yield_servings: 1, food_log_ids: [0] }, 'Invalid food log id'],
    [{ name: 'Meal', yield_servings: 1, food_log_ids: [1, 1] }, 'Duplicate food log id']
  ];

  for (const [body, message] of cases) {
    const res = createRes();
    await handler({ user: { id: 7 }, body }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { message });
  }
  assert.equal(transactionCalls, 0);
});

test('myFoods route: POST /recipes/from-food-logs hides missing and foreign log ownership', async () => {
  let receivedWhere = null;
  let createCalls = 0;
  const txStub = {
    foodLog: {
      findMany: async ({ where }) => {
        receivedWhere = where;
        return [{ id: 10 }];
      }
    },
    myFood: { create: async () => { createCalls += 1; } },
    recipeIngredient: { createMany: async () => {} }
  };
  const handler = getRouteHandler(loadMyFoodsRouter({ $transaction: async (fn) => fn(txStub) }), 'post', '/recipes/from-food-logs');
  const res = createRes();

  await handler({
    user: { id: 7 },
    body: { name: 'Dinner', yield_servings: 1, food_log_ids: [10, 11] }
  }, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: 'Food log not found' });
  assert.deepEqual(receivedWhere, { id: { in: [10, 11] }, user_id: 7 });
  assert.equal(createCalls, 0);
});

test('myFoods route: POST /recipes/from-food-logs requires one local meal before writing', async () => {
  const localDate = new Date('2026-08-02T00:00:00.000Z');
  let createCalls = 0;
  let returnedLogs = [
    { id: 10, local_date: localDate, meal_period: 'DINNER' },
    { id: 11, local_date: localDate, meal_period: 'EVENING_SNACK' }
  ];
  const txStub = {
    foodLog: {
      findMany: async () => returnedLogs
    },
    myFood: { create: async () => { createCalls += 1; } },
    recipeIngredient: { createMany: async () => {} }
  };
  const handler = getRouteHandler(loadMyFoodsRouter({ $transaction: async (fn) => fn(txStub) }), 'post', '/recipes/from-food-logs');
  const res = createRes();

  await handler({
    user: { id: 7 },
    body: { name: 'Dinner', yield_servings: 1, food_log_ids: [10, 11] }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Food logs must belong to the same meal and date' });

  returnedLogs = [
    { id: 10, local_date: localDate, meal_period: 'DINNER' },
    { id: 11, local_date: new Date('2026-08-03T00:00:00.000Z'), meal_period: 'DINNER' }
  ];
  const otherDateRes = createRes();
  await handler({
    user: { id: 7 },
    body: { name: 'Dinner', yield_servings: 1, food_log_ids: [10, 11] }
  }, otherDateRes);
  assert.equal(otherDateRes.statusCode, 400);
  assert.deepEqual(otherDateRes.body, { message: 'Food logs must belong to the same meal and date' });
  assert.equal(createCalls, 0);
});

test('myFoods route: POST /recipes/from-food-logs preserves caller order and all log snapshots', async () => {
  const localDate = new Date('2026-08-02T00:00:00.000Z');
  const makeLog = (overrides) => ({
    id: 1,
    local_date: localDate,
    meal_period: 'EVENING_SNACK',
    name: 'Ingredient',
    calories: 0,
    servings_consumed: null,
    serving_size_quantity_snapshot: null,
    serving_unit_label_snapshot: null,
    calories_per_serving_snapshot: null,
    external_source: null,
    external_id: null,
    brand_snapshot: null,
    locale_snapshot: null,
    barcode_snapshot: null,
    measure_label_snapshot: null,
    grams_per_measure_snapshot: null,
    measure_quantity_snapshot: null,
    grams_total_snapshot: null,
    ...overrides
  });
  const logs = [
    makeLog({ id: 11, name: 'Lime juice', calories: 0 }),
    makeLog({
      id: 22,
      name: 'Tequila',
      calories: 194,
      servings_consumed: 1.5,
      serving_size_quantity_snapshot: 1,
      serving_unit_label_snapshot: 'fl oz',
      calories_per_serving_snapshot: 129.3333333333,
      external_source: 'fatsecret',
      external_id: 'spirit-22',
      brand_snapshot: 'House',
      locale_snapshot: 'en-US',
      barcode_snapshot: '0123456789012',
      measure_label_snapshot: 'jigger',
      grams_per_measure_snapshot: 42,
      measure_quantity_snapshot: 1.5,
      grams_total_snapshot: 63
    })
  ];
  let recipeData = null;
  let ingredientData = null;
  const txStub = {
    // Deliberately return database order instead of the caller's requested [22, 11] order.
    foodLog: { findMany: async () => logs },
    myFood: {
      create: async ({ data }) => {
        recipeData = data;
        return { id: 55, ...data };
      }
    },
    recipeIngredient: {
      createMany: async ({ data }) => {
        ingredientData = data;
      }
    }
  };
  const handler = getRouteHandler(loadMyFoodsRouter({ $transaction: async (fn) => fn(txStub) }), 'post', '/recipes/from-food-logs');
  const res = createRes();

  await handler({
    user: { id: 7 },
    body: { name: '  Margarita  ', yield_servings: 2, food_log_ids: [22, 11] }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, 55);
  assert.deepEqual(recipeData, {
    user_id: 7,
    type: 'RECIPE',
    name: 'Margarita',
    serving_size_quantity: 1,
    serving_unit_label: 'serving',
    calories_per_serving: 97,
    recipe_total_calories: 194,
    yield_servings: 2
  });
  assert.equal(ingredientData.length, 2);
  assert.equal(ingredientData[0].sort_order, 1);
  assert.equal(ingredientData[0].name_snapshot, 'Tequila');
  assert.equal(ingredientData[0].source, 'EXTERNAL');
  assert.equal(ingredientData[0].source_my_food_id, null);
  assert.equal(ingredientData[0].quantity_servings, 1.5);
  assert.equal(ingredientData[0].serving_size_quantity_snapshot, 1);
  assert.equal(ingredientData[0].serving_unit_label_snapshot, 'fl oz');
  assert.equal(ingredientData[0].calories_per_serving_snapshot, 129.3333333333);
  assert.equal(ingredientData[0].external_source, 'fatsecret');
  assert.equal(ingredientData[0].external_id, 'spirit-22');
  assert.equal(ingredientData[0].brand_snapshot, 'House');
  assert.equal(ingredientData[0].locale_snapshot, 'en-US');
  assert.equal(ingredientData[0].barcode_snapshot, '0123456789012');
  assert.equal(ingredientData[0].measure_label_snapshot, 'jigger');
  assert.equal(ingredientData[0].grams_per_measure_snapshot, 42);
  assert.equal(ingredientData[0].measure_quantity_snapshot, 1.5);
  assert.equal(ingredientData[0].grams_total_snapshot, 63);
  assert.equal(ingredientData[1].sort_order, 2);
  assert.equal(ingredientData[1].name_snapshot, 'Lime juice');
  assert.equal(ingredientData[1].calories_total_snapshot, 0);
});

test('myFoods route: PATCH /:id updates an owned food without touching historical logs', async () => {
  let readCount = 0;
  let receivedUpdate = null;
  const prismaStub = {
    myFood: {
      findFirst: async () => {
        readCount += 1;
        return readCount === 1
          ? { id: 9, user_id: 7, type: 'FOOD' }
          : { id: 9, user_id: 7, type: 'FOOD', name: 'New oats', calories_per_serving: 190 };
      },
      updateMany: async (args) => {
        receivedUpdate = args;
        return { count: 1 };
      }
    }
  };
  const handler = getRouteHandler(loadMyFoodsRouter(prismaStub), 'patch', '/:id');
  const res = createRes();
  await handler({
    user: { id: 7 },
    params: { id: '9' },
    body: { name: ' New oats ', serving_size_quantity: 1, serving_unit_label: ' bowl ', calories_per_serving: 190 }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(receivedUpdate, {
    where: { id: 9, user_id: 7, type: 'FOOD' },
    data: { name: 'New oats', serving_size_quantity: 1, serving_unit_label: 'bowl', calories_per_serving: 190 }
  });
  assert.equal('foodLog' in prismaStub, false);
});

test('myFoods route: PATCH /:id atomically replaces only an owned recipe definition', async () => {
  let deletedWhere = null;
  let createdRows = null;
  const txStub = {
    myFood: { updateMany: async () => ({ count: 1 }) },
    recipeIngredient: {
      deleteMany: async ({ where }) => { deletedWhere = where; },
      createMany: async ({ data }) => { createdRows = data; }
    }
  };
  const prismaStub = {
    myFood: {
      findFirst: async () => ({ id: 10, user_id: 7, type: 'RECIPE', name: 'Soup' })
    },
    $transaction: async (fn) => fn(txStub)
  };
  const handler = getRouteHandler(loadMyFoodsRouter(prismaStub), 'patch', '/:id');
  const res = createRes();
  await handler({
    user: { id: 7 },
    params: { id: '10' },
    body: {
      name: 'Soup',
      serving_size_quantity: 1,
      serving_unit_label: 'bowl',
      yield_servings: 2,
      ingredients: [{ source: 'EXTERNAL', name: 'Broth', calories_total: 80 }]
    }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(deletedWhere, { recipe_id: 10 });
  assert.equal(createdRows.length, 1);
  assert.equal(createdRows[0].recipe_id, 10);
  assert.equal(createdRows[0].name_snapshot, 'Broth');
  assert.equal('foodLog' in txStub, false);
});

test('myFoods route: DELETE /:id scopes deletion to the owner and returns 404 otherwise', async () => {
  let receivedWhere = null;
  const prismaStub = {
    myFood: {
      deleteMany: async ({ where }) => {
        receivedWhere = where;
        return { count: where.id === 11 ? 1 : 0 };
      }
    }
  };
  const handler = getRouteHandler(loadMyFoodsRouter(prismaStub), 'delete', '/:id');
  const deleted = createRes();
  await handler({ user: { id: 7 }, params: { id: '11' } }, deleted);
  assert.equal(deleted.statusCode, 204);
  assert.equal(deleted.ended, true);
  assert.deepEqual(receivedWhere, { id: 11, user_id: 7 });

  const missing = createRes();
  await handler({ user: { id: 7 }, params: { id: '12' } }, missing);
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.body, { message: 'My food not found' });
});
