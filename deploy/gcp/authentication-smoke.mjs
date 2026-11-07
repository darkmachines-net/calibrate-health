/** @file Rehearse Firebase lifecycle and account/history copies on owned loopback Auth/Postgres services, without cloud credentials or email. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const backend = path.join(root, 'backend');
const requireBackend = createRequire(path.join(backend, 'package.json'));
const { Pool } = requireBackend('pg');
const name = `calibrate-firebase-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-firebase-test-'));
let created = false;
let emulator;
let pool;
let log;

/** Run Docker lifecycle commands with captured output, never displaying ephemeral credentials. */
function docker(args, env = process.env) {
  return execFileSync('docker', args, { env, encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Reserve an available loopback port; the Auth emulator must bind it before tests may proceed. */
async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Run host tests with inherited sanitized configuration while Postgres and the emulator remain responsive. */
async function test(env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-r', 'ts-node/register', '--test', '--test-concurrency=1', 'test/firebase-authority.integration.test.js', 'test/firebase-migration-apply.integration.test.js', 'test/firebase-account-copy.integration.test.js', 'test/tracking-history-copy.integration.test.js'], { cwd: backend, env, windowsHide: true, stdio: 'inherit', timeout: 180000 });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Firebase lifecycle test failed.')));
  });
}

try {
  const cli = process.env.FIREBASE_CLI_PATH;
  assert.ok(cli && path.isAbsolute(cli) && fs.existsSync(cli), 'Set FIREBASE_CLI_PATH to the official firebase-tools lib/bin/firebase.js entrypoint.');
  const port = await availablePort();
  fs.writeFileSync(path.join(temporary, 'firebase.json'), JSON.stringify({ emulators: { auth: { host: '127.0.0.1', port }, ui: { enabled: false }, singleProjectMode: true } }));
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DB_|DATABASE_URL$|PG|GOOGLE_|GCLOUD_|CLOUDSDK_|FIREBASE_|AUTH_PROVIDER$|DOTENV_)/i.test(key)));
  log = fs.openSync(path.join(temporary, 'emulator.log'), 'w');
  emulator = spawn(process.execPath, [cli, 'emulators:start', '--only', 'auth', '--project', 'demo-calibrate', '--config', path.join(temporary, 'firebase.json'), '--non-interactive'], { cwd: temporary, env: { ...baseEnv, CI: 'true' }, windowsHide: true, stdio: ['ignore', log, log] });
  let emulatorReady = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (emulator.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/emulator/v1/projects/demo-calibrate/config`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { emulatorReady = true; break; }
    } catch { /* Await loopback emulator startup. */ }
    await delay(500);
  }
  assert.ok(emulatorReady, 'Auth emulator did not become ready. Inspect its local startup log.');
  docker(['run', '--detach', '--rm', '--name', name, '--label', 'calibrate.purpose=firebase-test', '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=calibrate_test_firebase', 'postgres:16-alpine'], { ...baseEnv, POSTGRES_PASSWORD: password });
  created = true;
  const dbPort = Number(docker(['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', name]));
  assert.ok(Number.isInteger(dbPort) && dbPort > 0);
  const url = `postgresql://postgres:${password}@127.0.0.1:${dbPort}/calibrate_test_firebase`;
  pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1000 });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await pool.query('SELECT 1'); ready = true; break; } catch { await delay(500); }
  }
  assert.ok(ready, 'Disposable PostgreSQL did not become ready.');
  console.log('Testing Firebase Auth lifecycle using only loopback emulators and synthetic accounts.');
  await test({ ...baseEnv, NODE_ENV: 'test', CALIBRATE_FIREBASE_TEST_OWNED_DB: 'true', CALIBRATE_AUTH_TEST_DATABASE_URL: url, FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${port}`, FIREBASE_PROJECT_ID: 'demo-calibrate', FIREBASE_API_KEY: 'emulator-only', FIREBASE_SERVICE_ACCOUNT: 'test@demo-calibrate.iam.gserviceaccount.com', PUBLIC_APP_ORIGIN: 'http://localhost:3000', AUTH_PROVIDER: 'firebase' });
} catch (error) {
  console.error(error.message);
  console.error(`Emulator diagnostics are local to ${temporary}; they may contain synthetic action codes.`);
  process.exitCode = 1;
} finally {
  await pool?.end();
  if (created) docker(['rm', '--force', '--volumes', name]);
  if (emulator && emulator.exitCode === null) {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(emulator.pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe' });
    else emulator.kill('SIGTERM');
  }
  if (log !== undefined) fs.closeSync(log);
  if (!process.exitCode) fs.rmSync(temporary, { recursive: true, force: true });
}
