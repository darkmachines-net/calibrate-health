/** @file Verifies probe deadlines, disposal, and recovery without exposing database data. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabaseReadinessCheck } = require('../src/services/readiness');

test('database readiness reports success without exposing probe results', async () => {
  const released = [];
  const check = createDatabaseReadinessCheck({
    /** Lease a client that completes successfully. */
    async connect() {
      return {
        /** Return a synthetic result that the readiness check must not expose. */
        async query() { return { secret: 'not returned' }; },
        /** Record whether the client is safe to reuse. */
        release(discard) { released.push(discard); }
      };
    }
  });
  assert.equal(await check(), true);
  assert.deepEqual(released, [false]);
});

test('database readiness converts connection failures into a safe false result', async () => {
  const check = createDatabaseReadinessCheck({
    /** Reject acquisition with synthetic private connection data. */
    async connect() { throw new Error('postgresql://user:password@db/private'); }
  });
  assert.equal(await check(), false);
});

test('stalled acquisition shares the deadline and discards any late connection', async () => {
  let acquisitions = 0;
  const lease = Promise.withResolvers();
  const released = Promise.withResolvers();
  const check = createDatabaseReadinessCheck({
    /** Delay acquisition until the test supplies a client. */
    async connect() { acquisitions++; return lease.promise; }
  }, 15);

  const pending = check();
  assert.equal(check(), pending);
  assert.equal(await pending, false);
  assert.equal(await check(), false);
  assert.equal(acquisitions, 1);
  lease.resolve({
    /** Fail the test if the timed-out probe attempts a query. */
    query() { assert.fail('A late connection must never run the probe.'); },
    /** Resolve once the late lease has been disposed. */
    release: released.resolve
  });
  assert.equal(await released.promise, true);
});

test('interrupts stalled queries and serves later probes after the database recovers', async () => {
  const query = Promise.withResolvers();
  const released = [];
  let acquisitions = 0;
  const check = createDatabaseReadinessCheck({
    /** Stall the first query and succeed after the dead lease is dropped. */
    async connect() {
      const attempt = ++acquisitions;
      return {
        /** Simulate the driver settling the first query only after the socket is destroyed. */
        async query() { if (attempt === 1) await query.promise; },
        /** Simulate the pool destroying a leased client on forced release. */
        release(discard) {
          released.push(discard);
          if (attempt === 1) query.reject(new Error('Connection terminated'));
        }
      };
    }
  }, 15);

  assert.equal(await check(), false);
  assert.deepEqual(released, [true]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await check(), true);
  assert.equal(acquisitions, 2);
  assert.deepEqual(released, [true, false]);
});
