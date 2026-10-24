/** @file Regression coverage for client operations: executeIdempotentMutation replays the committed response without repeating the mutation. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

class PrismaKnownRequestErrorStub extends Error {
  constructor(code) {
    super(`Prisma error ${code}`);
    this.name = 'PrismaClientKnownRequestError';
    this.code = code;
  }
}

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

/** Load the service against an isolated Prisma stub while preserving the process module cache. */
function loadClientOperationsService(prismaStub) {
  const dbPath = require.resolve('../src/config/database');
  const prismaClientPath = require.resolve('@prisma/client');
  const servicePath = require.resolve('../src/services/clientOperations');
  const previousDbModule = require.cache[dbPath];
  const previousPrismaClientModule = require.cache[prismaClientPath];

  delete require.cache[servicePath];
  stubModule(dbPath, { __esModule: true, default: prismaStub });
  stubModule(prismaClientPath, {
    Prisma: {
      DbNull: null,
      PrismaClientKnownRequestError: PrismaKnownRequestErrorStub
    }
  });

  const loaded = require('../src/services/clientOperations');

  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
  if (previousPrismaClientModule) require.cache[prismaClientPath] = previousPrismaClientModule;
  else delete require.cache[prismaClientPath];

  return loaded;
}

/** Simulate the unique receipt constraint and committed transaction state in memory. */
function createPrismaStub() {
  const receipts = new Map();
  const syncChanges = [];
  const receiptKey = (userId, operationId) => `${userId}:${operationId}`;

  const tx = {
    clientOperation: {
      create: async ({ data }) => {
        const key = receiptKey(data.user_id, data.operation_id);
        if (receipts.has(key)) {
          throw new PrismaKnownRequestErrorStub('P2002');
        }
        receipts.set(key, {
          ...data,
          response_status: null,
          response_body: null,
          completed_at: null
        });
      },
      update: async ({ where, data }) => {
        const key = receiptKey(
          where.user_id_operation_id.user_id,
          where.user_id_operation_id.operation_id
        );
        const current = receipts.get(key);
        assert.ok(current, `Expected receipt ${key} before update`);
        const updated = { ...current, ...data };
        receipts.set(key, updated);
        return updated;
      }
    },
    syncChange: {
      create: async ({ data }) => {
        syncChanges.push(data);
        return { id: BigInt(syncChanges.length), ...data };
      }
    }
  };

  return {
    receipts,
    syncChanges,
    clientOperation: {
      findUnique: async ({ where }) =>
        receipts.get(
          receiptKey(
            where.user_id_operation_id.user_id,
            where.user_id_operation_id.operation_id
          )
        ) ?? null
    },
    $transaction: async (callback) => callback(tx),
    tx
  };
}

test('executeIdempotentMutation replays the committed response without repeating the mutation', async () => {
  const prismaStub = createPrismaStub();
  const { executeIdempotentMutation } = loadClientOperationsService(prismaStub);
  let mutationCalls = 0;
  const options = {
    userId: 7,
    operationId: 'operation-replay-001',
    operationKind: 'food.create',
    requestPayload: { calories: 320, name: 'Lunch' },
    mutate: async (tx, operationId) => {
      mutationCalls += 1;
      assert.equal(tx, prismaStub.tx);
      assert.equal(operationId, 'operation-replay-001');
      return { status: 201, body: { id: 44, created_at: new Date('2026-07-11T12:00:00.000Z') } };
    }
  };

  const first = await executeIdempotentMutation(options);
  const replay = await executeIdempotentMutation(options);

  assert.equal(mutationCalls, 1);
  assert.deepEqual(first, {
    status: 201,
    body: { created_at: '2026-07-11T12:00:00.000Z', id: 44 }
  });
  assert.deepEqual(replay, first);
});

test('executeIdempotentMutation replays a completed 204 with a null body without repeating the mutation', async () => {
  const prismaStub = createPrismaStub();
  const { executeIdempotentMutation } = loadClientOperationsService(prismaStub);
  let mutationCalls = 0;
  const options = {
    userId: 7,
    operationId: 'operation-delete-001',
    operationKind: 'food_log.delete',
    requestPayload: { id: 44 },
    mutate: async () => {
      mutationCalls += 1;
      return { status: 204, body: null };
    }
  };

  const first = await executeIdempotentMutation(options);
  const replay = await executeIdempotentMutation(options);

  assert.equal(mutationCalls, 1);
  assert.deepEqual(first, { status: 204, body: null });
  assert.deepEqual(replay, first);
});

test('executeIdempotentMutation reports a matching incomplete receipt as in progress', async () => {
  const prismaStub = createPrismaStub();
  const { ClientOperationConflictError, executeIdempotentMutation } = loadClientOperationsService(prismaStub);
  let mutationCalls = 0;
  const options = {
    userId: 7,
    operationId: 'operation-pending-001',
    operationKind: 'food_log.delete',
    requestPayload: { id: 44 },
    mutate: async () => {
      mutationCalls += 1;
      return { status: 204, body: null };
    }
  };

  await executeIdempotentMutation(options);
  const receipt = Array.from(prismaStub.receipts.values())[0];
  receipt.response_status = 204;
  receipt.response_body = null;
  receipt.completed_at = null;

  await assert.rejects(
    () => executeIdempotentMutation(options),
    (error) => {
      assert.ok(error instanceof ClientOperationConflictError);
      assert.equal(error.code, 'OPERATION_IN_PROGRESS');
      return true;
    }
  );
  assert.equal(mutationCalls, 1);
});

test('executeIdempotentMutation rejects reuse of an operation id for a different request', async () => {
  const prismaStub = createPrismaStub();
  const { ClientOperationConflictError, executeIdempotentMutation } = loadClientOperationsService(prismaStub);
  let mutationCalls = 0;

  await executeIdempotentMutation({
    userId: 3,
    operationId: 'operation-conflict-001',
    operationKind: 'food.create',
    requestPayload: { calories: 100 },
    mutate: async () => {
      mutationCalls += 1;
      return { status: 201, body: { id: 1 } };
    }
  });

  await assert.rejects(
    () =>
      executeIdempotentMutation({
        userId: 3,
        operationId: 'operation-conflict-001',
        operationKind: 'food.create',
        requestPayload: { calories: 200 },
        mutate: async () => {
          mutationCalls += 1;
          return { status: 201, body: { id: 2 } };
        }
      }),
    (error) => {
      assert.ok(error instanceof ClientOperationConflictError);
      assert.equal(error.code, 'OPERATION_ID_REUSED');
      return true;
    }
  );
  assert.equal(mutationCalls, 1);
});

test('the same client operation id remains isolated between users', async () => {
  const prismaStub = createPrismaStub();
  const { executeIdempotentMutation } = loadClientOperationsService(prismaStub);
  let mutationCalls = 0;

  const executeForUser = (userId) =>
    executeIdempotentMutation({
      userId,
      operationId: 'operation-shared-001',
      operationKind: 'metric.upsert',
      requestPayload: { date: '2026-07-11', weight: 80 },
      mutate: async () => {
        mutationCalls += 1;
        return { status: 200, body: { user_id: userId } };
      }
    });

  assert.deepEqual(await executeForUser(10), { status: 200, body: { user_id: 10 } });
  assert.deepEqual(await executeForUser(11), { status: 200, body: { user_id: 11 } });
  assert.deepEqual(await executeForUser(10), { status: 200, body: { user_id: 10 } });
  assert.equal(mutationCalls, 2);
  assert.equal(prismaStub.receipts.size, 2);
});

test('session-bound operations replay only for the originating mobile session', async () => {
  const prismaStub = createPrismaStub();
  const { ClientOperationConflictError, executeIdempotentMutation } = loadClientOperationsService(prismaStub);
  let mutationCalls = 0;
  const base = {
    userId: 7,
    mobileAuthSessionId: 73,
    operationId: 'watch-operation-001',
    operationKind: 'watch.food.create',
    requestPayload: { calories: 120 },
    mutate: async () => {
      mutationCalls += 1;
      return { status: 200, body: { food_log: { id: 44 } } };
    }
  };

  const first = await executeIdempotentMutation(base);
  assert.deepEqual(await executeIdempotentMutation(base), first);
  assert.equal(Array.from(prismaStub.receipts.values())[0].mobile_auth_session_id, 73);
  await assert.rejects(
    () => executeIdempotentMutation({ ...base, mobileAuthSessionId: 74 }),
    (error) => error instanceof ClientOperationConflictError && error.code === 'OPERATION_ID_REUSED'
  );
  assert.equal(mutationCalls, 1);
});

test('recordSyncChange stores entity identifiers as strings and JSON-safe payload values', async () => {
  const prismaStub = createPrismaStub();
  const { recordSyncChange } = loadClientOperationsService(prismaStub);

  await recordSyncChange({
    tx: prismaStub.tx,
    userId: 8,
    entityType: 'food_log',
    entityId: 9007199254740991,
    action: 'upsert',
    operationId: 'operation-sync-001',
    payload: {
      updated_at: new Date('2026-07-11T13:00:00.000Z'),
      nested: { z: 1, a: 2 }
    }
  });

  assert.deepEqual(prismaStub.syncChanges, [
    {
      user_id: 8,
      entity_type: 'food_log',
      entity_id: '9007199254740991',
      action: 'upsert',
      operation_id: 'operation-sync-001',
      payload: {
        nested: { a: 2, z: 1 },
        updated_at: '2026-07-11T13:00:00.000Z'
      }
    }
  ]);
});
test('food-copy operation IDs prevent duplicate writes across in-flight retries and exact replays', async () => {
  const prismaStub = createPrismaStub();
  const { ClientOperationConflictError, executeIdempotentMutation } = loadClientOperationsService(prismaStub);
  let releaseMutation;
  const mutationStarted = new Promise((resolve) => {
    releaseMutation = resolve;
  });
  let mutationCalls = 0;
  const requestPayload = {
    operation_id: 'food-copy-concurrent-001',
    source_date: '2026-08-08',
    target_date: '2026-08-09'
  };
  const options = {
    userId: 7,
    operationId: requestPayload.operation_id,
    operationKind: 'food_log.copy',
    requestPayload,
    mutate: async () => {
      mutationCalls += 1;
      await mutationStarted;
      return {
        status: 200,
        body: { ...requestPayload, copied_count: 2, food_logs: [{ id: 51 }, { id: 52 }] }
      };
    }
  };

  const first = executeIdempotentMutation(options);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => executeIdempotentMutation(options),
    (error) => error instanceof ClientOperationConflictError && error.code === 'OPERATION_IN_PROGRESS'
  );

  releaseMutation();
  const committed = await first;
  assert.deepEqual(await executeIdempotentMutation(options), committed);
  assert.equal(mutationCalls, 1);

  await assert.rejects(
    () => executeIdempotentMutation({
      ...options,
      requestPayload: { ...requestPayload, target_date: '2026-08-10' }
    }),
    (error) => error instanceof ClientOperationConflictError && error.code === 'OPERATION_ID_REUSED'
  );
  assert.equal(mutationCalls, 1);
});
