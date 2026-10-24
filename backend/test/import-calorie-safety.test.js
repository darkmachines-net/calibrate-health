/** @file Regression coverage for import calorie safety: Lose It weight import and sticky plan review roll back together when review marking fails. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(path, exports) {
  const stub = new Module(path);
  stub.exports = exports;
  stub.loaded = true;
  require.cache[path] = stub;
}

test('Lose It weight import and sticky plan review roll back together when review marking fails', async () => {
  const paths = {
    database: require.resolve('../src/config/database'),
    importService: require.resolve('../src/services/loseItImport'),
    review: require.resolve('../src/services/caloriePlanReview'),
    trend: require.resolve('../src/services/materializedWeightTrend'),
    route: require.resolve('../src/routes/imports')
  };
  const previous = new Map(Object.values(paths).map((path) => [path, require.cache[path]]));
  for (const path of Object.values(paths)) delete require.cache[path];

  const weight = {
    localDate: '2026-08-08',
    localDateValue: new Date('2026-08-08T00:00:00.000Z'),
    weightValue: 80
  };
  let stagedWrites = 0;
  let committedWrites = 0;
  const prismaStub = {
    $transaction: async (callback) => {
      let planningLocked = false;
      const tx = {
        $executeRaw: async () => { planningLocked = true; return 1; },
        user: { findUniqueOrThrow: async () => ({ timezone: 'UTC' }) },
        bodyMetric: {
          findMany: async () => { assert.equal(planningLocked, true); return []; },
          createMany: async ({ data }) => {
            assert.equal(planningLocked, true);
            stagedWrites += data.length;
            return { count: data.length };
          }
        }
      };
      try {
        const result = await callback(tx);
        committedWrites = stagedWrites;
        return result;
      } catch (error) {
        stagedWrites = 0;
        throw error;
      }
    }
  };
  stubModule(paths.database, prismaStub);
  stubModule(paths.importService, {
    parseLoseItExport: () => ({
      profile: {}, weights: [weight], bodyFat: [], foodLogs: [], warnings: [],
      foodDayCompletionStatus: 'unavailable'
    }),
    partitionLoseItWeightImportsByAsOfDate: (weights) => ({ eligible: weights, future: [] }),
    inferLoseItWeightUnit: () => ({ unit: 'KG', source: 'fallback' }),
    buildImportTimestamp: (date) => date
  });
  stubModule(paths.review, {
    markCurrentCaloriePlanForReviewIfUnsafe: async () => { throw new Error('marker failed'); }
  });
  stubModule(paths.trend, { refreshMaterializedWeightTrendsBestEffort: async () => undefined });

  const loaded = require('../src/routes/imports');
  const router = loaded.default ?? loaded;
  const route = router.stack.find((layer) => layer.route?.path === '/loseit/execute');
  const handler = route.route.stack.at(-1).handle;
  const response = { jsonCalled: false, json() { this.jsonCalled = true; return this; } };

  await assert.rejects(
    handler({
      user: { id: 7, timezone: 'UTC', weight_unit: 'KG' },
      file: { buffer: Buffer.from('stub') },
      body: { weight_unit: 'KG', food_conflict_mode: 'MERGE', weight_conflict_mode: 'KEEP', include_body_fat: false }
    }, response),
    /marker failed/
  );
  assert.equal(stagedWrites, 0);
  assert.equal(committedWrites, 0);
  assert.equal(response.jsonCalled, false);

  for (const [path, cached] of previous) {
    if (cached) require.cache[path] = cached;
    else delete require.cache[path];
  }
});
