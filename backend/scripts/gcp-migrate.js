/** @file Cloud Run migration-job entrypoint: apply Prisma migrations, create a restricted runtime login, and exit without starting HTTP. */
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Pool, escapeIdentifier, escapeLiteral } = require('pg');
let stage = 'configuration';

/**
 * Create/update a runtime login with the injected password and grant DML after migrations. The caller owns
 * the pool; this transaction releases its client on every path and rejects elevated
 * or migration-owning runtime identities. Intended only for the new Calibrate Cloud SQL database.
 */
async function grantRuntimeAccess(pool, runtime, password) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(runtime ?? '')) throw new Error('A valid runtime role is required.');
  if (typeof password !== 'string' || password.length < 32 || password.includes('\0')) throw new Error('A runtime password of at least 32 characters is required.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [identity] } = await client.query('SELECT current_user AS migrator, current_database() AS database');
    if (identity.migrator === runtime) throw new Error('Runtime and migration identities must differ.');
    const role = escapeIdentifier(runtime);
    const database = escapeIdentifier(identity.database);
    const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [runtime]);
    // Creating this login via SQL avoids Cloud SQL Admin API's implicit cloudsqlsuperuser grant.
    // PostgreSQL 16 gives this creator ADMIN OPTION; retries can safely update its password and grants.
    if (!existing.rows.length) await client.query(`CREATE ROLE ${role} LOGIN NOCREATEDB NOCREATEROLE`);
    // Role passwords cannot be bind parameters; pg's literal escaper handles arbitrary secret contents.
    await client.query(`ALTER ROLE ${role} LOGIN NOCREATEDB NOCREATEROLE PASSWORD ${escapeLiteral(password)}`);
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM ${role}`);
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await client.query(`REVOKE ALL ON TABLE public._prisma_migrations FROM ${role}`);
    await client.query(`GRANT SELECT ON TABLE public._prisma_migrations TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
    const { rows: [privileges] } = await client.query(`
      SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
        OR pg_has_role(oid, 'cloudsqlsuperuser', 'member')
        OR has_database_privilege(oid, current_database(), 'CREATE')
        OR has_schema_privilege(oid, 'public', 'CREATE')
        OR has_table_privilege(oid, 'public._prisma_migrations', 'INSERT,UPDATE,DELETE,TRUNCATE')
        OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relowner = pg_roles.oid)
        AS elevated FROM pg_roles WHERE rolname = $1`, [runtime]);
    if (!privileges || privileges.elevated) throw new Error('Runtime database role still has administrative privileges.');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Run only inside the built application image using the migrator's injected socket credentials. */
async function main() {
  const { resolveDatabaseConnection } = require('../dist/backend/src/config/databaseUtils.js');
  const connection = resolveDatabaseConnection();
  const runtime = process.env.RUNTIME_DB_USER;
  const password = process.env.RUNTIME_DB_PASSWORD;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(runtime ?? '') || runtime === connection.poolConfig.user || connection.schema !== 'public' || !password || password.length < 32 || password.includes('\0')) {
    throw new Error('Migration job requires a distinct runtime user and the public schema.');
  }
  // No shell or npm dependency: Dockerfile.app removes npm from the runtime image.
  stage = 'Prisma migrations';
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'), env: process.env, windowsHide: true,
    timeout: 540000, stdio: ['ignore', 'pipe', 'pipe']
  });
  const pool = new Pool(connection.poolConfig);
  stage = 'runtime-role permissions';
  try { await grantRuntimeAccess(pool, runtime, password); } finally { await pool.end(); }
  console.log('Calibrate migrations and runtime database permissions are ready.');
}

module.exports = { grantRuntimeAccess };
if (require.main === module) {
  main().catch(error => {
    // Driver/Prisma failures can embed credentials or SQL values; keep Cloud Logging output bounded.
    const code = /^[0-9A-Z]{5}$/.test(error.code ?? '') ? ` (SQLSTATE ${error.code})` : '';
    console.error(`Calibrate migration job failed during ${stage}${code}. Check database connectivity, Prisma migration state and runtime-role grants before serving traffic.`);
    process.exitCode = 1;
  });
}
