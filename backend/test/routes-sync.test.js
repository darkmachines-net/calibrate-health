/** @file Regression coverage for routes sync: sync route returns ordered changes with string cursors. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadSyncRouter(prismaStub) {
  const dbPath = require.resolve('../src/config/database');
  const routePath = require.resolve('../src/routes/sync');
  const previousDb = require.cache[dbPath];
  delete require.cache[routePath];
  stubModule(dbPath, prismaStub);
  const loaded = require('../src/routes/sync');
  if (previousDb) require.cache[dbPath] = previousDb;
  else delete require.cache[dbPath];
  return loaded.default ?? loaded;
}

function getRouteHandler(router, method, path) {
  const layer = router.stack.find(
    (candidate) => candidate.route && candidate.route.path === path && candidate.route.methods?.[method]
  );
  assert.ok(layer);
  return layer.route.stack[0].handle;
}

function createRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

test('sync route returns ordered changes with string cursors', async () => {
  let query;
  const router = loadSyncRouter({
    syncChange: {
      findMany: async (input) => {
        query = input;
        return [{
          id: 9007199254740993n,
          entity_type: 'body_metric',
          entity_id: '12',
          action: 'upsert',
          operation_id: 'operation-123',
          payload: { weight_grams: 80000 },
          created_at: new Date('2026-07-11T12:00:00.000Z')
        }];
      }
    }
  });
  const res = createRes();
  await getRouteHandler(router, 'get', '/changes')(
    { user: { id: 7 }, query: { after: '9007199254740992', limit: '25' } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(query.where.user_id, 7);
  assert.equal(query.where.id.gt, 9007199254740992n);
  assert.equal(query.take, 26);
  assert.equal(res.body.changes[0].cursor, '9007199254740993');
  assert.equal(res.body.next_cursor, '9007199254740993');
  assert.equal(res.body.changes[0].created_at, '2026-07-11T12:00:00.000Z');
});

test('sync route paginates without advancing past the returned page', async () => {
  const rows = [1n, 2n, 3n].map((id) => ({
    id,
    entity_type: 'food_log',
    entity_id: id.toString(),
    action: 'upsert',
    operation_id: null,
    payload: null,
    created_at: new Date('2026-07-11T12:00:00.000Z')
  }));
  const router = loadSyncRouter({ syncChange: { findMany: async () => rows } });
  const res = createRes();
  await getRouteHandler(router, 'get', '/changes')({ user: { id: 7 }, query: { limit: '2' } }, res);

  assert.equal(res.body.has_more, true);
  assert.equal(res.body.changes.length, 2);
  assert.equal(res.body.next_cursor, '2');
});

test('sync route rejects malformed cursors', async () => {
  const router = loadSyncRouter({ syncChange: { findMany: async () => [] } });
  const res = createRes();
  await getRouteHandler(router, 'get', '/changes')({ user: { id: 7 }, query: { after: '-1' } }, res);
  assert.equal(res.statusCode, 400);
});
