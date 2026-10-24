/** @file Regression coverage for database pool: real pg pool bounds waiting, recovers after release, and removes idle clients. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { Pool } = require('pg');
const { resolveDatabaseConnection } = require('../src/config/databaseUtils');

// Exercise the installed pg pool with disposable clients; no sockets or database server.
class SyntheticClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  connect(callback) { process.nextTick(callback); }
  end(callback) { this._ending = true; if (callback) process.nextTick(callback); }
}

const env = {
  DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/app?sslmode=disable',
  DB_POOL_MAX: '1', DB_POOL_ACQUIRE_TIMEOUT_SECONDS: '1', DB_POOL_IDLE_TIMEOUT_SECONDS: '1'
};

test('real pg pool bounds waiting, recovers after release, and removes idle clients', async () => {
  const pool = new Pool({ ...resolveDatabaseConnection(env).poolConfig, Client: SyntheticClient });
  // pg unrefs wait timers; keep only this synthetic test alive until its assertion completes.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const held = await pool.connect();
    const pending = pool.connect();
    assert.equal(pool.totalCount, 1);
    assert.equal(pool.waitingCount, 1);
    await assert.rejects(pending, /timeout exceeded when trying to connect/);
    assert.equal(pool.waitingCount, 0);
    held.release();
    const recovered = await pool.connect();
    assert.equal(recovered, held);
    const removed = once(pool, 'remove');
    recovered.release();
    await removed;
    assert.equal(pool.totalCount, 0);
    assert.equal(held._ending, true);
  } finally {
    clearInterval(keepAlive);
    await pool.end();
  }
});

test('failed acquisitions and idle errors release capacity for replacement', async () => {
  let fail = true;
  class FailingClient extends SyntheticClient {
    connect(callback) { process.nextTick(() => callback(fail ? new Error('synthetic connect failure') : undefined)); }
  }
  const pool = new Pool({ ...resolveDatabaseConnection(env).poolConfig, Client: FailingClient });
  const errors = [];
  pool.on('error', (error) => errors.push(error.message));
  try {
    await assert.rejects(pool.connect(), /synthetic connect failure/);
    assert.equal(pool.totalCount, 0);
    fail = false;
    const idle = await pool.connect();
    idle.release();
    idle.emit('error', new Error('synthetic idle failure'));
    assert.deepEqual(errors, ['synthetic idle failure']);
    assert.equal(pool.totalCount, 0);
    const replacement = await pool.connect();
    assert.notEqual(replacement, idle);
    replacement.release();
  } finally { await pool.end(); }
});

test('runtime owns one pool, passes schema to adapter, and ends pool even if Prisma disconnect fails', async () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  const originalEnv = process.env;
  const originalError = console.error;
  const messages = [];
  const pools = [];
  let adapter;
  let failDisconnect = false;
  let disconnects = 0;
  class TestPool extends Pool {
    constructor(options) { super({ ...options, Client: SyntheticClient }); pools.push(this); }
  }
  class TestAdapter {
    constructor(pool, options) { this.pool = pool; this.options = options; adapter = this; }
  }
  class TestPrisma {
    constructor(options) { assert.equal(options.adapter, adapter); }
    async $disconnect() { disconnects++; if (failDisconnect) throw new Error('synthetic disconnect failure'); }
  }
  const modulePath = require.resolve('../src/config/database');
  try {
    process.env = { ...env, DB_SCHEMA: 'private' };
    console.error = (message) => messages.push(message);
    Module._load = function (id, ...args) {
      if (id === 'pg') return { Pool: TestPool };
      if (id === '@prisma/adapter-pg') return { PrismaPg: TestAdapter };
      if (id === '@prisma/client') return { PrismaClient: TestPrisma };
      return originalLoad.call(this, id, ...args);
    };
    for (const shouldFail of [false, true]) {
      failDisconnect = shouldFail;
      delete require.cache[modulePath];
      const runtime = require(modulePath);
      assert.equal(runtime.pgPool, pools.at(-1));
      assert.equal(adapter.pool, runtime.pgPool);
      assert.equal(adapter.options.schema, 'private');
      assert.equal(runtime.pgPool.options.max, 1);
      const client = await runtime.pgPool.connect();
      client.release();
      client.emit('error', new Error('secret driver payload'));
      if (shouldFail) await assert.rejects(runtime.disconnectDatabase(), /synthetic disconnect failure/);
      else await runtime.disconnectDatabase();
      assert.equal(runtime.pgPool.ended, true);
    }
    assert.equal(pools.length, 2); // One pool per module instance, never a separate Prisma pool.
    assert.equal(disconnects, 2);
    assert.equal(messages.length, 2);
    assert.ok(messages.every((message) => !message.includes('secret')));
  } finally {
    Module._load = originalLoad;
    process.env = originalEnv;
    console.error = originalError;
    delete require.cache[modulePath];
    for (const pool of pools) if (!pool.ending) await pool.end();
  }
});
