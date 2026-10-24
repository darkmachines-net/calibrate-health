/** @file Regression coverage for food copy: food copy parser accepts a full-day request and builds a canonical operation payload. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadFoodCopyService() {
  const dbPath = require.resolve('../src/config/database');
  const servicePath = require.resolve('../src/services/foodCopy');
  const clientOperationsPath = require.resolve('../src/services/clientOperations');
  const foodTrackingPath = require.resolve('../src/services/foodTracking');
  const previousDbModule = require.cache[dbPath];

  delete require.cache[servicePath];
  delete require.cache[clientOperationsPath];
  delete require.cache[foodTrackingPath];
  stubModule(dbPath, { __esModule: true, default: {} });
  const loaded = require('../src/services/foodCopy');

  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
  return loaded;
}

const { copyFoodLogs, foodCopyOperationPayload, parseFoodCopyRequest } = loadFoodCopyService();

const validBody = {
  operation_id: 'food-copy-operation-001',
  source_date: '2026-08-08',
  target_date: '2026-08-09'
};

function requireParsed(body = validBody, userTimeZone = 'America/Los_Angeles') {
  const parsed = parseFoodCopyRequest({ body, userTimeZone });
  assert.equal(parsed.ok, true);
  return parsed.request;
}

test('food copy parser accepts a full-day request and builds a canonical operation payload', () => {
  const request = requireParsed();

  assert.equal(request.sourceDate.toISOString(), '2026-08-08T00:00:00.000Z');
  assert.equal(request.targetDate.toISOString(), '2026-08-09T00:00:00.000Z');
  assert.equal(request.mealMappings, undefined);
  assert.deepEqual(foodCopyOperationPayload(request), validBody);
});

test('food copy parser accepts same-date cross-meal copy and rejects unsafe or ambiguous shapes', () => {
  const sameDateCrossMeal = parseFoodCopyRequest({
    userTimeZone: 'UTC',
    body: {
      ...validBody,
      target_date: validBody.source_date,
      meal_mappings: [{ source_meal_period: 'BREAKFAST', target_meal_period: 'LUNCH' }]
    }
  });
  assert.equal(sameDateCrossMeal.ok, true);

  const invalidBodies = [
    validBody,
    { ...validBody, source_date: '2026-08-08T12:00:00Z' },
    { ...validBody, source_date: '2026-02-30' },
    { ...validBody, meal_mappings: [] },
    {
      ...validBody,
      meal_mappings: [
        { source_meal_period: 'BREAKFAST', target_meal_period: 'LUNCH' },
        { source_meal_period: 'BREAKFAST', target_meal_period: 'LUNCH' }
      ]
    },
    {
      ...validBody,
      target_date: validBody.source_date,
      meal_mappings: [{ source_meal_period: 'DINNER', target_meal_period: 'DINNER' }]
    }
  ];

  const parsingOptions = [
    { body: invalidBodies[0], userTimeZone: 'Mars/Olympus' },
    ...invalidBodies.slice(1).map((body) => ({ body, userTimeZone: 'UTC' }))
  ];
  for (const options of parsingOptions) {
    const parsed = parseFoodCopyRequest(options);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.statusCode, 400);
  }
});

test('food copy transaction preserves owned immutable snapshots and never mutates the source', async () => {
  const request = requireParsed({
    ...validBody,
    meal_mappings: [{ source_meal_period: 'BREAKFAST', target_meal_period: 'DINNER' }]
  });
  const source = {
    id: 41,
    user_id: 7,
    my_food_id: 12,
    date: new Date('2026-08-08T14:30:00.000Z'),
    local_date: new Date('2026-08-08T00:00:00.000Z'),
    meal_period: 'BREAKFAST',
    name: 'Provider snapshot',
    calories: 321,
    servings_consumed: 1.5,
    serving_size_quantity_snapshot: 2,
    serving_unit_label_snapshot: 'slices',
    calories_per_serving_snapshot: 214,
    external_source: 'fatsecret',
    external_id: 'provider-123',
    brand_snapshot: 'Snapshot brand',
    locale_snapshot: 'en-US',
    barcode_snapshot: '1234567890123',
    measure_label_snapshot: 'slice',
    grams_per_measure_snapshot: 30,
    measure_quantity_snapshot: 2,
    grams_total_snapshot: 90,
    created_at: new Date('2026-08-08T14:30:00.000Z')
  };
  let sourceQuery;
  const createdData = [];
  const syncChanges = [];
  const tx = {
    dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    $executeRaw: async () => 1,
    user: { findUnique: async () => ({ id: 7, timezone: 'UTC' }) },
    foodLogDay: {
      findUnique: async ({ where }) => ({
        id: 3,
        local_date: where.user_id_local_date.local_date,
        status: 'OPEN',
        origin: 'USER',
        completed_at: null,
        updated_at: new Date('2026-08-09T12:00:00.000Z')
      })
    },
    foodLog: {
      findMany: async (query) => {
        sourceQuery = query;
        return [source];
      },
      create: async ({ data }) => {
        createdData.push(data);
        return { id: 99, created_at: new Date('2026-08-09T12:01:00.000Z'), ...data };
      },
      update: async () => assert.fail('copy must not update a source row'),
      delete: async () => assert.fail('copy must not delete a source row')
    },
    syncChange: {
      create: async ({ data }) => {
        syncChanges.push(data);
        return { id: 1n, ...data };
      }
    }
  };

  const result = await copyFoodLogs({
    tx,
    userId: 7,
    request,
    operationId: request.operationId
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.copied_count, 1);
  assert.deepEqual(sourceQuery.where, {
    user_id: 7,
    local_date: new Date('2026-08-08T00:00:00.000Z'),
    meal_period: { in: ['BREAKFAST'] }
  });
  assert.equal(createdData[0].user_id, 7);
  assert.equal(createdData[0].meal_period, 'DINNER');
  assert.equal(createdData[0].date.toISOString(), '2026-08-09T00:00:00.000Z');
  assert.equal(createdData[0].local_date.toISOString(), '2026-08-09T00:00:00.000Z');
  for (const snapshotField of [
    'my_food_id',
    'name',
    'calories',
    'servings_consumed',
    'serving_size_quantity_snapshot',
    'serving_unit_label_snapshot',
    'calories_per_serving_snapshot',
    'external_source',
    'external_id',
    'brand_snapshot',
    'locale_snapshot',
    'barcode_snapshot',
    'measure_label_snapshot',
    'grams_per_measure_snapshot',
    'measure_quantity_snapshot',
    'grams_total_snapshot'
  ]) {
    assert.equal(createdData[0][snapshotField], source[snapshotField], snapshotField);
  }
  assert.equal(syncChanges.length, 1);
  assert.equal(syncChanges[0].operation_id, request.operationId);
  assert.equal(syncChanges[0].entity_id, '99');
});

test('food copy returns an empty successful receipt without creating rows', async () => {
  const request = requireParsed();
  let createCalls = 0;
  const tx = {
    dailyCaloriePlan: require('./helpers/dailyCaloriePlanStore')(),
    $executeRaw: async () => 1,
    user: { findUnique: async () => ({ id: 7, timezone: 'UTC' }) },
    foodLogDay: {
      findUnique: async ({ where }) => ({
        id: 3,
        local_date: where.user_id_local_date.local_date,
        status: 'OPEN',
        origin: 'USER',
        completed_at: null,
        updated_at: new Date('2026-08-09T12:00:00.000Z')
      })
    },
    foodLog: {
      findMany: async () => [],
      create: async () => {
        createCalls += 1;
        return {};
      }
    },
    syncChange: { create: async () => ({}) }
  };

  const result = await copyFoodLogs({ tx, userId: 7, request, operationId: request.operationId });

  assert.deepEqual(result.body, {
    operation_id: request.operationId,
    source_date: '2026-08-08',
    target_date: '2026-08-09',
    copied_count: 0,
    food_logs: []
  });
  assert.equal(createCalls, 0);
});

test('food copy honors the canonical target-day write gate before reading source logs', async () => {
  const request = requireParsed();
  let sourceRead = false;
  const tx = {
    $executeRaw: async () => 1,
    user: { findUnique: async () => ({ id: 7, timezone: 'UTC' }) },
    foodLogDay: {
      findUnique: async ({ where }) => ({
        id: 3,
        local_date: where.user_id_local_date.local_date,
        status: 'PAUSED',
        origin: 'PAUSE',
        completed_at: null,
        updated_at: new Date('2026-08-09T12:00:00.000Z')
      })
    },
    foodLog: {
      findMany: async () => {
        sourceRead = true;
        return [];
      }
    }
  };

  const result = await copyFoodLogs({ tx, userId: 7, request, operationId: request.operationId });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'FOOD_DAY_NOT_OPEN');
  assert.equal(sourceRead, false);
});
