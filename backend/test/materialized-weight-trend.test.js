const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadMaterializedWeightTrendService(prismaStub, model) {
  const dbPath = require.resolve('../src/config/database');
  const servicePath = require.resolve('../src/services/materializedWeightTrend');
  const weightTrendPath = require.resolve('../src/services/weightTrend');

  const previousDbModule = require.cache[dbPath];
  const previousWeightTrendModule = require.cache[weightTrendPath];
  const previousModel = process.env.WEIGHT_TREND_MODEL;
  delete require.cache[servicePath];
  delete require.cache[weightTrendPath];

  if (model === undefined) {
    delete process.env.WEIGHT_TREND_MODEL;
  } else {
    process.env.WEIGHT_TREND_MODEL = model;
  }

  const normalizedPrismaStub = {
    ...prismaStub,
    $queryRaw: prismaStub.$queryRaw ?? (async () => []),
    user: {
      findUnique: async () => ({ timezone: 'UTC' }),
      ...(prismaStub.user ?? {})
    }
  };
  normalizedPrismaStub.$transaction = prismaStub.$transaction
    ? (callback, options) => prismaStub.$transaction(
        (tx) => callback({
          $queryRaw: normalizedPrismaStub.$queryRaw,
          user: normalizedPrismaStub.user,
          ...tx
        }),
        options
      )
    : async (callback) => callback(normalizedPrismaStub);

  stubModule(dbPath, normalizedPrismaStub);
  const loaded = require('../src/services/materializedWeightTrend');

  if (previousDbModule) {
    require.cache[dbPath] = previousDbModule;
  } else {
    delete require.cache[dbPath];
  }

  if (previousWeightTrendModule) {
    require.cache[weightTrendPath] = previousWeightTrendModule;
  } else {
    delete require.cache[weightTrendPath];
  }

  if (previousModel === undefined) {
    delete process.env.WEIGHT_TREND_MODEL;
  } else {
    process.env.WEIGHT_TREND_MODEL = previousModel;
  }

  return loaded;
}

/**
 * Build an ascending daily metric history ending on the supplied date.
 */
function buildDailyMetricHistory(opts) {
  const rows = [];
  for (let index = 0; index < opts.count; index += 1) {
    const offsetDays = opts.count - index - 1;
    const date = new Date(opts.endDate);
    date.setUTCDate(date.getUTCDate() - offsetDays);
    rows.push({
      id: index + 1,
      user_id: opts.userId,
      date,
      weight_grams: 80000 - index * 15
    });
  }
  return rows;
}

test('materializedWeightTrend: recompute atomically replaces all rows with the active horizon', async () => {
  const userId = 31;
  const metrics = buildDailyMetricHistory({
    userId,
    count: 220,
    endDate: new Date('2026-02-16T00:00:00Z')
  });

  let deletedWhere = null;
  let insertedRows = null;
  let modelFindManyArgs = null;
  let transactionCount = 0;
  let transactionOptions = null;
  let advisoryLockQuery = null;
  const callOrder = [];
  const prismaStub = {
    $queryRaw: async (query) => {
      callOrder.push('lock');
      advisoryLockQuery = query;
      return [];
    },
    bodyMetric: {
      findFirst: async () => {
        callOrder.push('findLatest');
        return { date: metrics[metrics.length - 1].date };
      },
      findMany: async (args) => {
        callOrder.push('findMany');
        modelFindManyArgs = args;
        return metrics.filter((metric) => metric.date >= args.where.date.gte);
      }
    },
    bodyMetricTrend: {
      deleteMany: async (args) => {
        callOrder.push('delete');
        deletedWhere = args.where;
        return { count: 42 };
      },
      createMany: async (args) => {
        callOrder.push('create');
        insertedRows = args.data;
        return { count: args.data.length };
      }
    },
    $transaction: async (callback, options) => {
      transactionCount += 1;
      transactionOptions = options;
      return callback(prismaStub);
    }
  };
  const service = loadMaterializedWeightTrendService(prismaStub);

  await service.recomputeAndStoreUserWeightTrends(userId);

  const { activeStartDate, modelStartDate } = service.getMaterializedTrendWindowFromLatestDate(metrics[metrics.length - 1].date);
  assert.equal(modelFindManyArgs.where.date.gte.getTime(), modelStartDate.getTime());
  assert.deepEqual(modelFindManyArgs.where.user_id, userId);
  assert.deepEqual(deletedWhere, { user_id: userId });
  assert.ok(Array.isArray(insertedRows));
  assert.equal(transactionCount, 1, 'source reads, fit, and replacement should run in one transaction');
  assert.deepEqual(transactionOptions, { isolationLevel: 'RepeatableRead' });
  assert.match(advisoryLockQuery.strings.join('?'), /pg_advisory_xact_lock.*::text AS lock_result/);
  assert.deepEqual(callOrder, ['lock', 'findLatest', 'findMany', 'delete', 'create']);
  assert.equal(insertedRows.length, service.MATERIALIZED_TREND_ACTIVE_HORIZON_DAYS);
  assert.ok(insertedRows.every((row) => row.date >= activeStartDate));
  const expectedSourceRevision = service.computeWeightTrendSourceRevision(
    metrics.filter((metric) => metric.date >= modelStartDate)
  );
  assert.ok(insertedRows.every((row) => row.source_revision === expectedSourceRevision));
  assert.match(expectedSourceRevision, /^[a-f0-9]{64}$/);
  assert.ok(
    insertedRows.every(
      (row) =>
        Number.isInteger(row.trend_weight_grams) &&
        Number.isInteger(row.trend_ci_lower_grams) &&
        Number.isInteger(row.trend_ci_upper_grams) &&
        Number.isInteger(row.trend_std_grams) &&
        (row.trend_rate_grams_per_day === null || Number.isFinite(row.trend_rate_grams_per_day)) &&
        (row.trend_rate_std_grams_per_day === null || Number.isFinite(row.trend_rate_std_grams_per_day)) &&
        row.model_version === service.WEIGHT_TREND_MODEL_VERSION
    )
  );
});

test('materializedWeightTrend: v1 rollout writes version 1 rows without canonical rate state', async () => {
  const userId = 32;
  const asOfDate = new Date('2026-02-16T00:00:00Z');
  const metrics = buildDailyMetricHistory({ userId, count: 10, endDate: asOfDate });
  let insertedRows = null;
  let staleQuery = null;
  const prismaStub = {
    bodyMetric: {
      findFirst: async (args) => {
        if (args.where.OR) {
          staleQuery = args.where;
          return { id: metrics[metrics.length - 1].id };
        }
        return { date: metrics[metrics.length - 1].date };
      },
      findMany: async () => metrics
    },
    bodyMetricTrend: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async ({ data }) => {
        insertedRows = data;
        return { count: data.length };
      }
    },
    $transaction: async (callback) => callback(prismaStub)
  };
  const service = loadMaterializedWeightTrendService(prismaStub, 'v1');

  await service.ensureMaterializedWeightTrends(userId, asOfDate);

  assert.equal(service.WEIGHT_TREND_MODEL_VERSION, 1);
  assert.deepEqual(staleQuery.OR, [
    { trend: { is: null } },
    { trend: { is: { model_version: { not: 1 } } } },
    { trend: { is: { source_revision: null } } },
    { trend: { is: { source_revision: { not: insertedRows[0].source_revision } } } }
  ]);
  assert.equal(insertedRows.length, metrics.length);
  assert.ok(insertedRows.every((row) => row.source_revision === insertedRows[0].source_revision));
  assert.ok(insertedRows.every((row) => row.model_version === 1));
  assert.ok(insertedRows.every((row) => row.trend_rate_grams_per_day === null));
  assert.ok(insertedRows.every((row) => row.trend_rate_std_grams_per_day === null));
});

test('materializedWeightTrend: excludes future-dated metrics from the model and active-horizon anchor', async () => {
  const userId = 44;
  const asOfDate = new Date('2026-02-16T00:00:00Z');
  const eligibleMetrics = buildDailyMetricHistory({ userId, count: 20, endDate: asOfDate });
  const futureMetric = {
    id: 999,
    user_id: userId,
    date: new Date('2026-12-31T00:00:00Z'),
    weight_grams: 120000
  };
  const allMetrics = [...eligibleMetrics, futureMetric];
  let insertedRows = [];
  let latestFindArgs = null;
  let modelFindArgs = null;
  const prismaStub = {
    user: { findUnique: async () => ({ timezone: 'UTC' }) },
    bodyMetric: {
      findFirst: async (args) => {
        latestFindArgs = args;
        const eligible = allMetrics.filter((metric) => metric.date <= args.where.date.lte);
        return eligible.length > 0 ? { date: eligible[eligible.length - 1].date } : null;
      },
      findMany: async (args) => {
        modelFindArgs = args;
        return allMetrics.filter(
          (metric) => metric.date >= args.where.date.gte && metric.date <= args.where.date.lte
        );
      }
    },
    bodyMetricTrend: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async ({ data }) => {
        insertedRows = data;
        return { count: data.length };
      }
    }
  };
  prismaStub.$transaction = async (callback) => callback(prismaStub);
  const service = loadMaterializedWeightTrendService(prismaStub);

  await service.recomputeAndStoreUserWeightTrends(userId, undefined, asOfDate);

  assert.equal(latestFindArgs.where.date.lte.getTime(), asOfDate.getTime());
  assert.equal(modelFindArgs.where.date.lte.getTime(), asOfDate.getTime());
  assert.ok(insertedRows.length > 0);
  assert.ok(insertedRows.every((row) => row.date <= asOfDate));
  assert.equal(insertedRows.some((row) => row.metric_id === futureMetric.id), false);
});

test('materializedWeightTrend: rounds v2 level fields while preserving floating-point rate state', async () => {
  const asOfDate = new Date('2026-02-16T00:00:00Z');
  const metric = {
    id: 7,
    user_id: 3,
    date: asOfDate,
    weight_grams: 80123
  };
  let insertedRows = [];
  const prismaStub = {
    user: { findUnique: async () => ({ timezone: 'UTC' }) },
    bodyMetric: {
      findFirst: async () => ({ date: metric.date }),
      findMany: async () => [metric]
    },
    bodyMetricTrend: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async ({ data }) => {
        insertedRows = data;
        return { count: data.length };
      }
    }
  };
  prismaStub.$transaction = async (callback) => callback(prismaStub);
  const service = loadMaterializedWeightTrendService(prismaStub);

  await service.recomputeAndStoreUserWeightTrends(3, undefined, asOfDate);

  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0].trend_weight_grams, 80123);
  assert.equal(insertedRows[0].trend_std_grams, 900);
  assert.equal(insertedRows[0].trend_ci_lower_grams, 78359);
  assert.equal(insertedRows[0].trend_ci_upper_grams, 81887);
  assert.equal(insertedRows[0].trend_rate_grams_per_day, 0);
  assert.equal(insertedRows[0].trend_rate_std_grams_per_day, 150);
  assert.equal(insertedRows[0].model_version, 2);
});

test('materializedWeightTrend: ensure refreshes active rows from an older model version', async () => {
  const asOfDate = new Date('2026-02-16T00:00:00Z');
  const metric = { id: 1, user_id: 8, date: asOfDate, weight_grams: 80000 };
  let staleQuery = null;
  let insertedRows = [];
  const prismaStub = {
    user: { findUnique: async () => ({ timezone: 'UTC' }) },
    bodyMetric: {
      findFirst: async (args) => {
        if (args.where.OR) {
          staleQuery = args.where;
          return { id: metric.id };
        }
        return { date: metric.date };
      },
      findMany: async () => [metric]
    },
    bodyMetricTrend: {
      deleteMany: async () => ({ count: 1 }),
      createMany: async ({ data }) => {
        insertedRows = data;
        return { count: data.length };
      }
    }
  };
  prismaStub.$transaction = async (callback) => callback(prismaStub);
  const service = loadMaterializedWeightTrendService(prismaStub);

  const availability = await service.ensureMaterializedWeightTrends(8, asOfDate);

  assert.deepEqual(staleQuery.OR, [
    { trend: { is: null } },
    { trend: { is: { model_version: { not: service.WEIGHT_TREND_MODEL_VERSION } } } },
    { trend: { is: { source_revision: null } } },
    { trend: { is: { source_revision: { not: insertedRows[0].source_revision } } } }
  ]);
  assert.equal(availability, 'available');
  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0].model_version, service.WEIGHT_TREND_MODEL_VERSION);
});

test('materializedWeightTrend: ensure refreshes upgraded rows with a null source revision', async () => {
  const userId = 49;
  const asOfDate = new Date('2026-02-16T00:00:00Z');
  const metric = { id: 1, user_id: userId, date: asOfDate, weight_grams: 80000 };
  let insertedRows = [];
  let nullRevisionPredicateSeen = false;
  const prismaStub = {
    bodyMetric: {
      findFirst: async (args) => {
        if (!args.where.OR) return { date: metric.date };
        nullRevisionPredicateSeen = args.where.OR.some(
          (entry) => entry.trend?.is?.source_revision === null
        );
        return nullRevisionPredicateSeen ? { id: metric.id } : null;
      },
      findMany: async () => [metric]
    },
    bodyMetricTrend: {
      deleteMany: async () => ({ count: 1 }),
      createMany: async ({ data }) => {
        insertedRows = data;
        return { count: data.length };
      }
    }
  };
  prismaStub.$transaction = async (callback) => callback(prismaStub);
  const service = loadMaterializedWeightTrendService(prismaStub);

  const availability = await service.ensureMaterializedWeightTrends(userId, asOfDate);

  assert.equal(nullRevisionPredicateSeen, true);
  assert.equal(availability, 'available');
  assert.equal(insertedRows.length, 1);
  assert.match(insertedRows[0].source_revision, /^[a-f0-9]{64}$/);
});

test('materializedWeightTrend: captures one repeatable source revision after taking the advisory lock', async () => {
  const userId = 52;
  const asOfDate = new Date('2026-02-16T00:00:00Z');
  const revisionOne = buildDailyMetricHistory({ userId, count: 3, endDate: asOfDate });
  const revisionTwo = revisionOne.map((metric) => ({
    ...metric,
    id: metric.id + 100,
    weight_grams: metric.weight_grams + 5000
  }));
  let currentRevision = revisionOne;
  let transactionSnapshot = null;
  let insertedRows = [];
  let transactionOptions = null;
  const callOrder = [];
  const prismaStub = {
    $queryRaw: async () => {
      callOrder.push('lock');
      transactionSnapshot = currentRevision.map((metric) => ({ ...metric }));
      return [];
    },
    bodyMetric: {
      findFirst: async () => {
        callOrder.push('findLatest');
        const latest = transactionSnapshot[transactionSnapshot.length - 1];
        currentRevision = revisionTwo;
        return { date: latest.date };
      },
      findMany: async () => {
        callOrder.push('findMany');
        return transactionSnapshot;
      }
    },
    bodyMetricTrend: {
      deleteMany: async () => {
        callOrder.push('delete');
        return { count: 3 };
      },
      createMany: async ({ data }) => {
        callOrder.push('create');
        insertedRows = data;
        return { count: data.length };
      }
    },
    $transaction: async (callback, options) => {
      transactionOptions = options;
      return callback(prismaStub);
    }
  };
  const service = loadMaterializedWeightTrendService(prismaStub);

  await service.recomputeAndStoreUserWeightTrends(userId, prismaStub, asOfDate);

  assert.deepEqual(transactionOptions, { isolationLevel: 'RepeatableRead' });

  assert.deepEqual(callOrder, ['lock', 'findLatest', 'findMany', 'delete', 'create']);
  assert.deepEqual(insertedRows.map((row) => row.metric_id), revisionOne.map((metric) => metric.id));
  assert.equal(insertedRows.some((row) => row.metric_id >= 100), false);
  assert.ok(insertedRows.every(
    (row) => row.source_revision === service.computeWeightTrendSourceRevision(revisionOne)
  ));
});

test('materializedWeightTrend: retries a waiting repeatable-read conflict from a fresh source snapshot', async () => {
  const userId = 57;
  const asOfDate = new Date('2026-02-16T00:00:00Z');
  const revisionOne = buildDailyMetricHistory({ userId, count: 4, endDate: asOfDate });
  const revisionTwo = revisionOne.map((metric) => ({
    ...metric,
    weight_grams: metric.weight_grams + 1200
  }));
  let transactionAttempts = 0;
  let lockCount = 0;
  let finalRows = [];
  const transactionOptions = [];
  const prismaStub = {
    $transaction: async (callback, options) => {
      transactionAttempts += 1;
      transactionOptions.push(options);
      const attempt = transactionAttempts;
      const snapshot = (attempt === 1 ? revisionOne : revisionTwo).map((metric) => ({ ...metric }));
      const tx = {
        $queryRaw: async () => {
          lockCount += 1;
          return [];
        },
        user: { findUnique: async () => ({ timezone: 'UTC' }) },
        bodyMetric: {
          findFirst: async () => ({ date: snapshot[snapshot.length - 1].date }),
          findMany: async () => snapshot
        },
        bodyMetricTrend: {
          deleteMany: async () => ({ count: attempt === 1 ? 0 : revisionOne.length }),
          createMany: async ({ data }) => {
            if (attempt === 1) {
              throw Object.assign(new Error('stale RR snapshot unique conflict'), { code: 'P2002' });
            }
            finalRows = data;
            return { count: data.length };
          }
        }
      };
      return callback(tx);
    }
  };
  const service = loadMaterializedWeightTrendService(prismaStub);

  await service.recomputeAndStoreUserWeightTrends(userId, prismaStub, asOfDate);

  assert.equal(transactionAttempts, 2);
  assert.equal(lockCount, 2, 'the retry must reacquire the transaction-scoped advisory lock');
  assert.deepEqual(transactionOptions, [
    { isolationLevel: 'RepeatableRead' },
    { isolationLevel: 'RepeatableRead' }
  ]);
  const expectedRevision = service.computeWeightTrendSourceRevision(revisionTwo);
  assert.ok(finalRows.every((row) => row.source_revision === expectedRevision));
  assert.notEqual(expectedRevision, service.computeWeightTrendSourceRevision(revisionOne));
});

test('materializedWeightTrend: serializes concurrent recomputes without mixing source revisions', async () => {
  const userId = 58;
  const asOfDate = new Date('2026-02-16T00:00:00Z');
  const revisionOne = buildDailyMetricHistory({ userId, count: 4, endDate: asOfDate });
  const revisionTwo = revisionOne.map((metric) => ({
    ...metric,
    id: metric.id + 100,
    weight_grams: metric.weight_grams + 3000
  }));
  let currentRevision = revisionOne;
  let lockQueue = Promise.resolve();
  let activeLockHolders = 0;
  let maxActiveLockHolders = 0;
  const insertedBatches = [];
  const transactionOptions = [];
  const prismaStub = {
    $transaction: async (callback, options) => {
      transactionOptions.push(options);
      const priorLock = lockQueue;
      let releaseLock;
      lockQueue = new Promise((resolve) => {
        releaseLock = resolve;
      });
      let transactionSnapshot = null;
      const tx = {
        $queryRaw: async () => {
          await priorLock;
          activeLockHolders += 1;
          maxActiveLockHolders = Math.max(maxActiveLockHolders, activeLockHolders);
          transactionSnapshot = currentRevision.map((metric) => ({ ...metric }));
          return [];
        },
        user: { findUnique: async () => ({ timezone: 'UTC' }) },
        bodyMetric: {
          findFirst: async () => ({ date: transactionSnapshot[transactionSnapshot.length - 1].date }),
          findMany: async () => transactionSnapshot
        },
        bodyMetricTrend: {
          deleteMany: async () => ({ count: 4 }),
          createMany: async ({ data }) => {
            insertedBatches.push(data);
            if (insertedBatches.length === 1) currentRevision = revisionTwo;
            return { count: data.length };
          }
        }
      };
      try {
        return await callback(tx);
      } finally {
        if (transactionSnapshot) activeLockHolders -= 1;
        releaseLock();
      }
    }
  };
  const service = loadMaterializedWeightTrendService(prismaStub);

  await Promise.all([
    service.recomputeAndStoreUserWeightTrends(userId, prismaStub, asOfDate),
    service.recomputeAndStoreUserWeightTrends(userId, prismaStub, asOfDate)
  ]);

  assert.equal(maxActiveLockHolders, 1);
  assert.deepEqual(transactionOptions, [
    { isolationLevel: 'RepeatableRead' },
    { isolationLevel: 'RepeatableRead' }
  ]);
  assert.deepEqual(insertedBatches[0].map((row) => row.metric_id), revisionOne.map((metric) => metric.id));
  assert.deepEqual(insertedBatches[1].map((row) => row.metric_id), revisionTwo.map((metric) => metric.id));
  assert.ok(insertedBatches[0].every(
    (row) => row.source_revision === service.computeWeightTrendSourceRevision(revisionOne)
  ));
  assert.ok(insertedBatches[1].every(
    (row) => row.source_revision === service.computeWeightTrendSourceRevision(revisionTwo)
  ));
  assert.notEqual(insertedBatches[0][0].source_revision, insertedBatches[1][0].source_revision);
});
test('materializedWeightTrend: failed replacement rolls back and retains the last-known-good rows', async () => {
  const userId = 61;
  const asOfDate = new Date('2026-02-16T00:00:00Z');
  const metrics = buildDailyMetricHistory({ userId, count: 3, endDate: asOfDate });
  const lastKnownGood = [{ metric_id: 900, user_id: userId, model_version: 2 }];
  let persistedRows = lastKnownGood.map((row) => ({ ...row }));
  let deleteAttempted = false;
  const prismaStub = {
    bodyMetric: {
      findFirst: async () => ({ date: metrics[metrics.length - 1].date }),
      findMany: async () => metrics
    },
    $transaction: async (callback) => {
      let transactionRows = persistedRows.map((row) => ({ ...row }));
      const tx = {
        $queryRaw: async () => [],
        user: { findUnique: async () => ({ timezone: 'UTC' }) },
        bodyMetric: prismaStub.bodyMetric,
        bodyMetricTrend: {
          deleteMany: async () => {
            deleteAttempted = true;
            transactionRows = [];
            return { count: lastKnownGood.length };
          },
          createMany: async ({ data }) => {
            transactionRows = data;
            throw new Error('replacement write failed for trend_weight_grams=79999');
          }
        }
      };
      await callback(tx);
      persistedRows = transactionRows;
    }
  };
  const service = loadMaterializedWeightTrendService(prismaStub);

  await assert.rejects(
    service.recomputeAndStoreUserWeightTrends(userId, prismaStub, asOfDate),
    /replacement write failed/
  );

  assert.equal(deleteAttempted, true);
  assert.deepEqual(persistedRows, lastKnownGood);
});

test('materializedWeightTrend: best-effort refresh preserves last-known-good rows on fit failure', async () => {
  let deleteCount = 0;
  const prismaStub = {
    bodyMetric: {
      findFirst: async () => ({ date: new Date('2026-02-16T00:00:00Z') }),
      findMany: async () => {
        throw new Error('recompute read failed for weight_grams=80123');
      }
    },
    bodyMetricTrend: {
      deleteMany: async () => {
        deleteCount += 1;
        return { count: 12 };
      }
    }
  };
  const service = loadMaterializedWeightTrendService(prismaStub);
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));

  let availability;
  try {
    availability = await service.refreshMaterializedWeightTrendsBestEffort(42);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(availability, 'unavailable');
  assert.equal(deleteCount, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /last-known-good trend snapshot was preserved/);
  assert.doesNotMatch(warnings[0], /80123|weight_grams|recompute read failed/);
});

test('materializedWeightTrend: ensure returns unavailable without leaking refresh details', async () => {
  let deleteCount = 0;
  const metricDate = new Date('2026-02-16T00:00:00Z');
  const prismaStub = {
    bodyMetric: {
      findFirst: async (args) => (args.where.OR ? { id: 1 } : { date: metricDate }),
      findMany: async () => {
        throw new Error('fit failed for weight_grams=80123');
      }
    },
    bodyMetricTrend: {
      deleteMany: async () => {
        deleteCount += 1;
        return { count: 1 };
      }
    }
  };
  const service = loadMaterializedWeightTrendService(prismaStub);
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));

  let availability;
  try {
    availability = await service.ensureMaterializedWeightTrends(17, metricDate);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(availability, 'unavailable');
  assert.equal(deleteCount, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /trend status unavailable/);
  assert.doesNotMatch(warnings[0], /80123|weight_grams|fit failed/);
});

test('materializedWeightTrend: same-day source edit remains stale when refitting fails', async () => {
  const userId = 67;
  const metricDate = new Date('2026-02-16T00:00:00Z');
  const oldMetric = { id: 1, user_id: userId, date: metricDate, weight_grams: 80000 };
  const updatedMetric = { ...oldMetric, weight_grams: 81234 };
  let modelWindowReads = 0;
  let staleQuery = null;
  let deleteCount = 0;
  const prismaStub = {
    bodyMetric: {
      findFirst: async (args) => {
        if (args.where.OR) {
          staleQuery = args.where;
          return { id: updatedMetric.id };
        }
        return { date: metricDate };
      },
      findMany: async () => {
        modelWindowReads += 1;
        if (modelWindowReads === 1) return [updatedMetric];
        throw new Error('persistent fit failure for updated source');
      }
    },
    bodyMetricTrend: {
      deleteMany: async () => {
        deleteCount += 1;
        return { count: 1 };
      }
    }
  };
  const service = loadMaterializedWeightTrendService(prismaStub);
  const oldRevision = service.computeWeightTrendSourceRevision([oldMetric]);
  const updatedRevision = service.computeWeightTrendSourceRevision([updatedMetric]);
  const originalWarn = console.warn;
  console.warn = () => {};

  let availability;
  try {
    availability = await service.ensureMaterializedWeightTrends(userId, metricDate);
  } finally {
    console.warn = originalWarn;
  }

  assert.notEqual(updatedRevision, oldRevision);
  assert.equal(staleQuery.OR[3].trend.is.source_revision.not, updatedRevision);
  assert.equal(availability, 'unavailable');
  assert.equal(modelWindowReads, 2, 'ensure inspection and locked recompute must both read the source');
  assert.equal(deleteCount, 0, 'failed fitting must preserve the old materialized rows');
});

test('materializedWeightTrend: successful empty-history refresh is available and clears old rows once', async () => {
  let deleteCount = 0;
  const prismaStub = {
    bodyMetric: {
      findFirst: async () => null
    },
    bodyMetricTrend: {
      deleteMany: async () => {
        deleteCount += 1;
        return { count: 0 };
      }
    }
  };
  const service = loadMaterializedWeightTrendService(prismaStub);
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));

  let availability;
  try {
    availability = await service.refreshMaterializedWeightTrendsBestEffort(9);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(availability, 'available');
  assert.equal(deleteCount, 1);
  assert.deepEqual(warnings, []);
});
