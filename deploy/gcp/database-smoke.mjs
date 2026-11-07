/** @file Rehearse the production migration job and runtime SQL permissions against disposable PostgreSQL, with all validation commands on the host. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const backend = path.join(root, 'backend');
const requireBackend = createRequire(path.join(backend, 'package.json'));
const { Pool } = requireBackend('pg');
const name = `calibrate-gcp-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
let created = false;
let admin;
let runtime;

/** Run Docker management commands without a shell, protecting ephemeral credentials from logs. */
function docker(args, env = process.env) {
  return execFileSync('docker', args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Run the built image's migration entrypoint on the host while the test database remains responsive. */
async function migrate(env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/gcp-migrate.js'], {
      cwd: backend, env, windowsHide: true, timeout: 600000, stdio: ['ignore', 'inherit', 'inherit']
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Migration job exited ${code}.`)));
  });
}

try {
  console.log('Starting disposable PostgreSQL for the GCP migration rehearsal.');
  docker(['run', '--detach', '--rm', '--name', name, '--label', 'calibrate.purpose=gcp-test',
    '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=calibrate_gcp_test', 'postgres:16-alpine'],
  { ...process.env, POSTGRES_PASSWORD: password });
  created = true;
  const port = Number(docker(['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', name]));
  assert.ok(Number.isInteger(port) && port > 0);
  const config = { host: '127.0.0.1', port, database: 'calibrate_gcp_test', password, ssl: false, connectionTimeoutMillis: 1000 };
  admin = new Pool({ ...config, user: 'postgres' });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await admin.query('SELECT 1'); ready = true; break; } catch { await delay(500); }
  }
  assert.ok(ready, 'Disposable PostgreSQL did not become ready.');
  // Use a non-superuser migrator; the job must create its runtime role without implicit administrative membership.
  await admin.query('CREATE ROLE cloudsqlsuperuser');
  await admin.query(`CREATE ROLE calibrate_migrator LOGIN CREATEDB CREATEROLE PASSWORD '${password}'`);
  await admin.query('GRANT cloudsqlsuperuser TO calibrate_migrator WITH ADMIN OPTION');
  await admin.query('ALTER DATABASE calibrate_gcp_test OWNER TO calibrate_migrator');
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DB_|DATABASE_URL$|PG|DOTENV_)/i.test(key)));
  const env = { ...baseEnv, DB_HOST: config.host, DB_PORT: String(port), DB_NAME: config.database,
    DB_USER: 'calibrate_migrator', DB_PASSWORD: password, DB_SCHEMA: 'public', DB_SSLMODE: 'disable', DB_POOL_MAX: '1',
    RUNTIME_DB_USER: 'calibrate_runtime', RUNTIME_DB_PASSWORD: password, DOTENV_CONFIG_PATH: path.join(backend, 'nonexistent-gcp-test.env') };
  await migrate(env);
  runtime = new Pool({ ...config, user: 'calibrate_runtime' });
  const ledger = await runtime.query('SELECT count(*)::integer AS count FROM public._prisma_migrations WHERE finished_at IS NOT NULL');
  assert.ok(ledger.rows[0].count > 0, 'Expected the real Prisma migrations.');
  // New migrator-owned tables inherit runtime DML; sequences retain usage after a future migration.
  await admin.query('SET ROLE calibrate_migrator');
  await admin.query('CREATE TABLE public.gcp_permission_probe (id serial PRIMARY KEY, value text NOT NULL)');
  await admin.query('RESET ROLE');
  const inserted = await runtime.query("INSERT INTO public.gcp_permission_probe(value) VALUES ('synthetic') RETURNING id");
  await runtime.query("UPDATE public.gcp_permission_probe SET value='updated' WHERE id=$1", [inserted.rows[0].id]);
  await runtime.query('DELETE FROM public.gcp_permission_probe WHERE id=$1', [inserted.rows[0].id]);
  await runtime.query('SELECT count(*) FROM public."User"');
  for (const statement of [
    'CREATE TABLE public.forbidden_table(id integer)',
    'CREATE SCHEMA forbidden_schema',
    'DELETE FROM public._prisma_migrations',
    'TRUNCATE public._prisma_migrations',
    'CREATE ROLE forbidden_role'
  ]) {
    await assert.rejects(runtime.query(statement), error => error.code === '42501');
  }
  await migrate(env);
  assert.equal((await runtime.query('SELECT count(*)::integer AS count FROM public._prisma_migrations WHERE finished_at IS NOT NULL')).rows[0].count, ledger.rows[0].count);
  console.log(`Passed: ${ledger.rows[0].count} Prisma migrations, runtime DML/sequence access, denied administrative writes and a successful job retry.`);
} catch {
  console.error('GCP database rehearsal failed. Check Docker availability and the preceding migration/assertion step; no existing database is used.');
  process.exitCode = 1;
} finally {
  await runtime?.end();
  await admin?.end();
  if (created) {
    try { docker(['rm', '--force', '--volumes', name]); }
    catch { console.error(`Remove only the disposable test container ${name} after inspecting its status.`); process.exitCode = 1; }
  }
}
