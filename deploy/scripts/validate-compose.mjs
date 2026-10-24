/** @file Checks deployment Compose configuration against the supported self-hosted service and secret boundaries. */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const deployDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validationEnvironment = {
  ...process.env,
  APP_IMAGE: 'calibrate:validation',
  APP_HOST: 'calibrate.example.test',
  CADDY_EMAIL: 'operator@example.test',
  SESSION_SECRET: 'validation-only-session-secret-32-bytes',
  DATABASE_URL: 'postgresql://calibrate:validation@db.example.test:5432/calibrate?schema=public&sslmode=require',
  POSTGRES_PASSWORD: 'validation-only-postgres-password',
  BACKUP_AGE_RECIPIENT: 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  BACKUP_DB_HOST: 'db.example.test',
  BACKUP_DB_NAME: 'calibratehealth',
  BACKUP_DB_USER: 'calibratehealth',
  BACKUP_DB_PASSWORD: 'validation-only-backup-password'
};

const combinations = [
  ['Caddy + external Postgres', ['docker-compose.yml', 'docker-compose.backup.yml']],
  ['Caddy + in-stack Postgres', ['docker-compose.yml', 'docker-compose.postgres.yml', 'docker-compose.backup.yml']],
  ['Traefik + external Postgres', ['docker-compose.traefik.yml', 'docker-compose.backup.yml']],
  ['Traefik + in-stack Postgres', ['docker-compose.traefik.yml', 'docker-compose.postgres.yml', 'docker-compose.backup.yml']]
];

for (const [label, files] of combinations) {
  const args = ['compose'];
  for (const file of files) args.push('-f', file);
  args.push('config', '--quiet');
  const result = spawnSync('docker', args, {
    cwd: deployDirectory,
    env: validationEnvironment,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error) {
    throw new Error(`Unable to run Docker Compose validation (${result.error.message}).`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} Compose validation failed:\n${result.stderr || result.stdout}`);
  }
  console.log(`[deploy] ${label}: valid`);
}
