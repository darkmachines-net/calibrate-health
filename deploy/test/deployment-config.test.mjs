/** @file Verify portable self-hosting, image readiness and backup/startup contracts independently of the optional GCP deployment. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const deployDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(deployDirectory, '..');
/** Read a repository-owned deployment template for contract assertions. */
const readDeploy = (file) => fs.readFileSync(path.join(deployDirectory, file), 'utf8');

test('Caddy and Traefik share DB-backed app readiness semantics', () => {
  const caddyCompose = readDeploy('docker-compose.yml');
  const traefikCompose = readDeploy('docker-compose.traefik.yml');
  const caddyfile = readDeploy('Caddyfile.prod');
  for (const content of [caddyCompose, traefikCompose, caddyfile]) {
    assert.match(content, /\/api\/v1\/readyz/);
  }
  assert.match(caddyCompose, /condition: service_healthy/);
  assert.match(traefikCompose, /loadbalancer\.healthcheck\.path=\/api\/v1\/readyz/);
  assert.match(caddyfile, /\{\$APP_HOST\}/);
  assert.doesNotMatch(caddyfile, /calibratehealth\.app/);
});

test('the image healthcheck succeeds only when application readiness succeeds', async (t) => {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile.app'), 'utf8');
  const healthcheck = dockerfile.match(/HEALTHCHECK[^\r\n]*\\\r?\n\s+CMD (\[[^\r\n]+\])/);
  assert.ok(healthcheck, 'existing Compose stacks must inherit an image healthcheck');
  const [binary, ...args] = JSON.parse(healthcheck[1]);
  assert.equal(binary, 'node');
  let status = 200;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(status);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const options = { env: { ...process.env, PORT: String(server.address().port) }, timeout: 5000, windowsHide: true };
  await promisify(execFile)(process.execPath, args, options);
  status = 503;
  await assert.rejects(promisify(execFile)(process.execPath, args, options), (error) => error.code === 1);
  assert.deepEqual(requests, ['/api/v1/readyz', '/api/v1/readyz']);
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(promisify(execFile)(process.execPath, args, options), (error) => error.code === 1);
});

test('production image and Compose serve the Expo web artifact', () => {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile.app'), 'utf8');
  const caddyCompose = readDeploy('docker-compose.yml');
  const traefikCompose = readDeploy('docker-compose.traefik.yml');
  assert.match(
    dockerfile,
    /COPY scripts\/expo-cli-environment\.mjs scripts\/expo-web-build\.mjs scripts\/expo-web-release\.mjs \.\/scripts\//
  );
  assert.match(dockerfile, /RUN npm run build:expo-web/);
  assert.match(dockerfile, /COPY --from=build \/app\/mobile\/dist \/app\/web\/dist/);
  assert.doesNotMatch(dockerfile, /COPY --from=build \/app\/frontend\/dist/);
  for (const compose of [caddyCompose, traefikCompose]) {
    assert.match(compose, /FRONTEND_DIST_DIR: \/app\/web\/dist/);
    assert.doesNotMatch(compose, /FRONTEND_DIST_DIR: \/app\/frontend\/dist/);
  }
});

test('in-stack Postgres remains private and gates app startup on DB health', () => {
  const postgres = readDeploy('docker-compose.postgres.yml');
  assert.match(postgres, /pg_isready/);
  assert.match(postgres, /condition: service_healthy/);
  assert.match(postgres, /postgres_data:\/var\/lib\/postgresql\/data/);
  assert.doesNotMatch(postgres, /ports:/);
  assert.match(postgres, /DB_SSLMODE: disable/);
});

test('backup pipeline encrypts before promotion and limits retention to completed dumps', () => {
  const backup = readDeploy('backup/backup-postgres.sh');
  assert.match(backup, /pg_dump/);
  assert.match(backup, /age --encrypt --recipient/);
  assert.match(backup, /\.dump\.age/);
  assert.match(backup, /\.partial/);
  assert.match(backup, /BACKUP_RETENTION_DAYS/);
  assert.match(backup, /-name 'calibrate-\*\.dump\.age'/);
  assert.match(backup, /trap cleanup EXIT INT TERM HUP/);
  assert.match(backup, /mktemp \/tmp\/calibrate-postgres\.dump\.XXXXXX/);
  assert.doesNotMatch(backup, /XXXXXX\.dump/);
  assert.ok(backup.indexOf('age --encrypt') < backup.indexOf('mv "$partial" "$destination"'));
});

test('restore refuses accidental destructive use and never writes a plaintext dump to the backup volume', () => {
  const restore = readDeploy('backup/restore-postgres.sh');
  assert.match(restore, /CONFIRM_RESTORE_TO_EMPTY_DATABASE/);
  assert.match(restore, /target database contains/);
  assert.match(restore, /pg_restore --list/);
  assert.match(restore, /--exit-on-error/);
  assert.doesNotMatch(restore, /--clean/);
  assert.doesNotMatch(restore, />\s*\/backups\/.*\.dump(?!\.age)/);
});

test('production startup retries migrations before opening the app process', () => {
  const startup = fs.readFileSync(path.join(repositoryRoot, 'backend/scripts/start-prod.sh'), 'utf8');
  assert.match(startup, /MIGRATION_MAX_ATTEMPTS/);
  assert.match(startup, /until \.\/node_modules\/\.bin\/prisma migrate deploy/);
  assert.ok(
    startup.indexOf('until ./node_modules/.bin/prisma migrate deploy') <
      startup.indexOf('exec node dist/backend/src/index.js')
  );
});

test('portable Compose deployments remain independent of the optional GCP configuration', () => {
  for (const file of fs.readdirSync(deployDirectory).filter(entry => /^docker-compose.*\.yml$/.test(entry))) {
    assert.doesNotMatch(readDeploy(file), /gcp\/|google_|cloudsql|terraform/i);
  }
  const release = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'release.config.json'), 'utf8'));
  assert.deepEqual(release.server.deployment, { service: 'calibratehealth', path: '/deploy/calibratehealth' });
});
