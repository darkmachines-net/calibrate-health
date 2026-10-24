/** @file Regression coverage for routes activity: activity route requires trusted mobile provenance for Health Connect writes. */

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

function loadActivityRouter(prismaStub) {
  const dbPath = require.resolve('../src/config/database');
  const routePath = require.resolve('../src/routes/activity');
  const clientOperationsPath = require.resolve('../src/services/clientOperations');
  const previousDb = require.cache[dbPath];
  const previousClientOperations = require.cache[clientOperationsPath];
  delete require.cache[routePath];
  delete require.cache[clientOperationsPath];

  const normalized = {
    activityRecord: {
      findMany: async () => [],
      findUnique: async () => null,
      create: async ({ data }) => storedRecord(data),
      update: async ({ data }) => storedRecord(data),
      deleteMany: async () => ({ count: 0 }),
      ...(prismaStub.activityRecord ?? {})
    },
    activityDaySummary: {
      findMany: async () => [],
      findUnique: async () => null,
      create: async ({ data }) => storedSummary(data),
      update: async ({ data }) => storedSummary(data),
      ...(prismaStub.activityDaySummary ?? {})
    },
    healthConnectSyncState: {
      findUnique: async () => null,
      upsert: async ({ create }) => create,
      ...(prismaStub.healthConnectSyncState ?? {})
    },
    healthConnectTombstone: {
      findUnique: async () => null,
      upsert: async ({ create }) => create,
      ...(prismaStub.healthConnectTombstone ?? {})
    },
    syncChange: {
      create: async () => ({ id: 1n }),
      ...(prismaStub.syncChange ?? {})
    },
    ...prismaStub
  };
  normalized.$transaction = prismaStub.$transaction ?? (async (callback) => callback(normalized));
  stubModule(dbPath, { __esModule: true, default: normalized });
  const operationReceipts = new Map();
  class ClientOperationConflictError extends Error {}
  stubModule(clientOperationsPath, {
    ClientOperationConflictError,
    parseClientOperationId: (value) => {
      if (value === undefined) return undefined;
      return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value.trim())
        ? value.trim()
        : null;
    },
    executeIdempotentMutation: async (options) => {
      if (options.operationId && operationReceipts.has(options.operationId)) {
        return operationReceipts.get(options.operationId);
      }
      const result = await normalized.$transaction((tx) => options.mutate(tx, options.operationId));
      if (options.operationId) operationReceipts.set(options.operationId, result);
      return result;
    },
    recordSyncChange: async (options) => {
      await options.tx.syncChange.create({
        data: {
          user_id: options.userId,
          entity_type: options.entityType,
          entity_id: String(options.entityId),
          action: options.action,
          operation_id: options.operationId,
          payload: options.payload
        }
      });
    }
  });
  const loaded = require('../src/routes/activity');

  if (previousDb) require.cache[dbPath] = previousDb;
  else delete require.cache[dbPath];
  if (previousClientOperations) require.cache[clientOperationsPath] = previousClientOperations;
  else delete require.cache[clientOperationsPath];
  return loaded.default ?? loaded;
}

function storedRecord(data) {
  const now = new Date('2026-07-11T13:00:00Z');
  return { id: 1, ...data, created_at: now, updated_at: now };
}

function storedSummary(data) {
  const now = new Date('2026-07-11T13:00:00Z');
  return { id: 1, ...data, created_at: now, updated_at: now };
}

function createRes(locals = {}) {
  return {
    locals,
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

function getRouteHandler(router, method, path) {
  const layer = router.stack.find(
    (candidate) => candidate.route && candidate.route.path === path && candidate.route.methods?.[method]
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

function syncRequest(overrides = {}) {
  return {
    user: { id: 7, timezone: 'America/Los_Angeles' },
    headers: {},
    get: (name) => name.toLowerCase() === 'x-client-operation-id' ? 'activity-operation-1' : undefined,
    body: {
      sync_mode: 'incremental',
      record_type: 'STEPS',
      previous_changes_token: null,
      next_changes_token: 'next-token',
      upserts: [{
        record_id: 'steps-1',
        data_origin: 'com.sec.android.app.shealth',
        source_updated_at: '2026-07-11T12:15:00Z',
        start_time: '2026-07-11T12:00:00Z',
        end_time: '2026-07-11T12:15:00Z',
        count: 800
      }],
      deleted_record_ids: [],
      day_summaries: [{
        local_date: '2026-07-11',
        steps: 800,
        active_calories_kcal: null,
        total_calories_kcal: null,
        exercise_minutes: null,
        observed_at: '2026-07-11T12:15:00Z'
      }]
    },
    ...overrides
  };
}

test('activity route requires trusted mobile provenance for Health Connect writes', async () => {
  const router = loadActivityRouter({});
  const res = createRes();
  await getRouteHandler(router, 'post', '/health-connect/sync')(syncRequest(), res);

  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /authenticated mobile device/);
});

test('activity route advances the token with source writes in one transaction', async () => {
  const successesBefore = operationCount('health_connect_ingestion', 'successes');
  let transactions = 0;
  let stateUpsert;
  let recordCreate;
  const capturedRouter = loadActivityRouter({
    activityRecord: {
      findUnique: async () => null,
      create: async ({ data }) => {
        recordCreate = data;
        return storedRecord(data);
      }
    },
    healthConnectSyncState: {
      findUnique: async () => null,
      upsert: async (input) => {
        stateUpsert = input;
        return input.create;
      }
    },
    $transaction: async (callback) => {
      transactions += 1;
      return callback(transactionStub);
    }
  });

  // Reuse the delegates installed by loadActivityRouter through a minimal transaction object.
  const transactionStub = {
    activityRecord: {
      findUnique: async () => null,
      create: async ({ data }) => { recordCreate = data; return storedRecord(data); }
    },
    activityDaySummary: {
      findUnique: async () => null,
      create: async ({ data }) => storedSummary(data)
    },
    healthConnectSyncState: {
      findUnique: async () => null,
      upsert: async (input) => { stateUpsert = input; return input.create; }
    },
    healthConnectTombstone: { findUnique: async () => null },
    syncChange: { create: async () => ({ id: 1n }) }
  };
  const res = createRes({ mobileDeviceId: 'phone-1' });
  await getRouteHandler(capturedRouter, 'post', '/health-connect/sync')(syncRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.upserted, 1);
  assert.equal(res.body.day_summaries_upserted, 1);
  assert.equal(recordCreate.source_device_id, 'phone-1');
  assert.equal(recordCreate.local_date.toISOString(), '2026-07-11T00:00:00.000Z');
  assert.equal(stateUpsert.create.changes_token, 'next-token');
  assert.equal(transactions, 1);
  assert.equal(operationCount('health_connect_ingestion', 'successes'), successesBefore + 1);
});

test('activity route rejects out-of-order token pages before domain writes', async () => {
  const conflictsBefore = operationCount('health_connect_ingestion', 'conflicts');
  let creates = 0;
  const tx = {
    activityRecord: {
      create: async () => { creates += 1; }
    },
    healthConnectSyncState: {
      findUnique: async () => ({ changes_token: 'server-token' })
    }
  };
  const router = loadActivityRouter({ $transaction: async (callback) => callback(tx) });
  const req = syncRequest({
    body: { ...syncRequest().body, previous_changes_token: 'different-token' }
  });
  const res = createRes({ mobileDeviceId: 'phone-1' });
  await getRouteHandler(router, 'post', '/health-connect/sync')(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'HEALTH_CONNECT_TOKEN_MISMATCH');
  assert.equal(creates, 0);
  assert.equal(operationCount('health_connect_ingestion', 'conflicts'), conflictsBefore + 1);
});

test('activity route returns every requested date with optional summary and records', async () => {
  const localDate = new Date('2026-07-11T00:00:00Z');
  let summaryWhere;
  let recordWhere;
  const router = loadActivityRouter({
    activityDaySummary: {
      findMany: async ({ where }) => {
        summaryWhere = where;
        return [storedSummary({
          source_device_id: 'phone-1',
          local_date: localDate,
          steps: 1000,
          active_calories_kcal: null,
          total_calories_kcal: null,
          exercise_minutes: null,
          observed_at: new Date('2026-07-11T20:00:00Z')
        })];
      }
    },
    activityRecord: {
      findMany: async ({ where }) => {
        recordWhere = where;
        return [];
      }
    }
  });
  const res = createRes();
  await getRouteHandler(router, 'get', '/days')({
    user: { id: 7, timezone: 'UTC' },
    query: { start: '2026-07-11', end: '2026-07-12' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.days.length, 2);
  assert.equal(res.body.days[0].summary.steps, 1000);
  assert.equal(res.body.days[0].summary.source_device_id, undefined);
  assert.equal(res.body.days[1].summary, null);
  assert.equal(summaryWhere.user_id, 7);
  assert.equal(recordWhere.user_id, 7);
});

test('activity route authoritatively replaces a reset window and replays without a second delete', async () => {
  const records = [
    storedRecord({
      user_id: 7,
      source_device_id: 'phone-1',
      record_type: 'STEPS',
      external_id: 'missing-from-health-connect',
      local_date: new Date('2026-07-05T00:00:00Z'),
      source_updated_at: new Date('2026-07-05T12:00:00Z')
    }),
    storedRecord({
      id: 2,
      user_id: 7,
      source_device_id: 'phone-1',
      record_type: 'STEPS',
      external_id: 'outside-window',
      local_date: new Date('2026-06-01T00:00:00Z'),
      source_updated_at: new Date('2026-06-01T12:00:00Z')
    })
  ];
  let replacementDeletes = 0;
  let tombstonesCleared = 0;
  const activityRecord = {
    findMany: async ({ where }) => records
      .filter((record) => record.user_id === where.user_id
        && record.source_device_id === where.source_device_id
        && record.record_type === where.record_type
        && record.local_date >= where.local_date.gte
        && record.local_date <= where.local_date.lte)
      .map(({ external_id }) => ({ external_id })),
    deleteMany: async ({ where }) => {
      const before = records.length;
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        const inWindow = where.local_date
          ? record.local_date >= where.local_date.gte && record.local_date <= where.local_date.lte
          : record.external_id === where.external_id;
        if (record.user_id === where.user_id && record.source_device_id === where.source_device_id
          && record.record_type === where.record_type && inWindow) records.splice(index, 1);
      }
      const count = before - records.length;
      if (where.local_date) replacementDeletes += 1;
      return { count };
    },
    findUnique: async ({ where }) => {
      const key = where.user_id_source_device_id_record_type_external_id;
      return records.find((record) => record.user_id === key.user_id
        && record.source_device_id === key.source_device_id
        && record.record_type === key.record_type
        && record.external_id === key.external_id) ?? null;
    },
    create: async ({ data }) => {
      const saved = storedRecord({ ...data, id: records.length + 10 });
      records.push(saved);
      return saved;
    }
  };
  const router = loadActivityRouter({
    activityRecord,
    healthConnectTombstone: {
      deleteMany: async () => { tombstonesCleared += 1; return { count: 1 }; },
      findUnique: async () => null,
      upsert: async ({ create }) => create
    }
  });
  const req = syncRequest({
    body: {
      ...syncRequest().body,
      sync_mode: 'reset',
      previous_changes_token: null,
      replace_window: { start_date: '2026-07-01', end_date: '2026-07-11' },
      upserts: [{ ...syncRequest().body.upserts[0], record_id: 'current-record' }],
      day_summaries: []
    }
  });
  const first = createRes({ mobileDeviceId: 'phone-1' });
  const replay = createRes({ mobileDeviceId: 'phone-1' });
  const handler = getRouteHandler(router, 'post', '/health-connect/sync');
  await handler(req, first);
  await handler(req, replay);

  assert.equal(first.body.reset_deleted, 1);
  assert.deepEqual(replay.body, first.body);
  assert.equal(replacementDeletes, 1);
  assert.equal(tombstonesCleared, 1);
  assert.deepEqual(records.map(({ external_id }) => external_id).sort(), ['current-record', 'outside-window']);
});
