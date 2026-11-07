/** @file Exercise migration-role isolation, failure rollback and client release without live cloud credentials. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { grantRuntimeAccess } = require('../scripts/gcp-migrate');
const password = 'synthetic-runtime-password-with-more-than-32-characters';

/** Simulate database responses while retaining the ordered privilege statements and connection lifecycle. */
function fixture({ migrator = 'calibrate_migrator', elevated = false, failure = '' } = {}) {
  const statements = [];
  let released = false;
  const client = {
    async query(sql, parameters) {
      statements.push({ sql, parameters });
      if (failure && sql.includes(failure)) throw new Error('simulated SQL failure');
      if (sql.startsWith('SELECT current_user')) return { rows: [{ migrator, database: 'calibrate' }] };
      if (sql.includes('AS elevated')) return { rows: [{ elevated }] };
      return { rows: [] };
    },
    release() { released = true; }
  };
  return { pool: { async connect() { return client; } }, statements, isReleased: () => released };
}

test('runtime can write app data but cannot mutate the migration ledger or create schema objects', async () => {
  const db = fixture();
  await grantRuntimeAccess(db.pool, 'calibrate_runtime', password);
  const sql = db.statements.map(statement => statement.sql);
  assert.equal(sql[0], 'BEGIN');
  assert.equal(sql.at(-1), 'COMMIT');
  assert.ok(sql.includes('CREATE ROLE "calibrate_runtime" LOGIN NOCREATEDB NOCREATEROLE'));
  assert.ok(sql.includes('REVOKE ALL ON TABLE public._prisma_migrations FROM "calibrate_runtime"'));
  assert.ok(sql.includes('GRANT SELECT ON TABLE public._prisma_migrations TO "calibrate_runtime"'));
  assert.ok(sql.includes('REVOKE CREATE ON SCHEMA public FROM PUBLIC'));
  assert.match(sql.find(value => value.includes('AS elevated')), /relowner = pg_roles.oid/);
  assert.deepEqual(db.statements.find(statement => statement.parameters).parameters, ['calibrate_runtime']);
  assert.equal(db.isReleased(), true);
});

test('invalid or identical runtime roles cannot alter grants', async () => {
  for (const runtime of ['', undefined, 'name";DROP ROLE x', 'calibrate_migrator']) {
    const db = fixture();
    await assert.rejects(grantRuntimeAccess(db.pool, runtime, password));
    assert.equal(db.statements.some(statement => statement.sql.startsWith('REVOKE')), false);
  }
});

test('SQL failures and inherited administrative privileges fail closed and release the client', async () => {
  for (const options of [{ failure: 'GRANT USAGE' }, { elevated: true }]) {
    const db = fixture(options);
    await assert.rejects(grantRuntimeAccess(db.pool, 'calibrate_runtime', password));
    assert.equal(db.statements.at(-1).sql, 'ROLLBACK');
    assert.equal(db.statements.some(statement => statement.sql === 'COMMIT'), false);
    assert.equal(db.isReleased(), true);
  }
});

test('missing or malformed runtime secrets fail before acquiring a database connection', async () => {
  for (const invalid of [undefined, '', 'short', `${password}\0`]) {
    const db = fixture();
    await assert.rejects(grantRuntimeAccess(db.pool, 'calibrate_runtime', invalid), /password/);
    assert.deepEqual(db.statements, []);
  }
});
