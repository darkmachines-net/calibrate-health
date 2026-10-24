#!/usr/bin/env node
/** @file Isolated PostgreSQL backup/restore rehearsal with owned-resource cleanup and data verification. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const backupBuildContext = path.join(repositoryRoot, 'deploy', 'backup');
const GENERATED_ID_PATTERN = /^[a-f0-9]{12}$/;
const GENERATED_SQL_NAME_PATTERN = /^calibrate_backup_restore_smoke_[a-f0-9]{12}(?:_(?:source|restore|user))?$/;
const BACKUP_FILE_PATTERN = /^calibrate-\d{8}T\d{6}Z\.dump\.age$/;
const POSTGRES_IMAGE = 'postgres:16-alpine';
const POSTGRES_READY_TIMEOUT_MS = 45_000;
const BACKUP_READY_TIMEOUT_MS = 60_000;
const OWNERSHIP_LABEL = 'com.calibrate.backup-restore-smoke';
const POSTGRES_INIT_COMPLETE_MARKER = 'PostgreSQL init process complete; ready for start up.';

/** Create collision-resistant names so cleanup can target only resources from this run. */
export function createResourcePlan(id = crypto.randomBytes(6).toString('hex')) {
  if (!GENERATED_ID_PATTERN.test(id)) {
    throw new Error(`Refusing unsafe backup/restore smoke id: ${id}`);
  }
  const prefix = `calibrate-br-smoke-${id}`;
  const sqlPrefix = `calibrate_backup_restore_smoke_${id}`;
  return {
    id,
    prefix,
    image: `calibrate-backup-restore-smoke:${id}`,
    network: `${prefix}-network`,
    volumes: {
      backups: `${prefix}-backups`,
      identity: `${prefix}-identity`,
    },
    containers: {
      source: `${prefix}-source-db`,
      restore: `${prefix}-restore-db`,
      backup: `${prefix}-backup-job`,
      identity: `${prefix}-identity-job`,
      recipient: `${prefix}-recipient-job`,
      restoreJob: `${prefix}-restore-job`,
    },
    aliases: {
      source: `${prefix}-source`,
      restore: `${prefix}-restore`,
    },
    database: {
      source: `${sqlPrefix}_source`,
      restore: `${sqlPrefix}_restore`,
      user: `${sqlPrefix}_user`,
      schema: sqlPrefix,
    },
  };
}

/** Refuse remote Docker contexts because the drill creates and deletes disposable resources. */
export function assertLocalDockerEndpoint(rawEndpoint) {
  const endpoint = String(rawEndpoint ?? '').trim();
  if (!endpoint) throw new Error('Docker context does not expose a daemon endpoint.');
  if (endpoint.startsWith('npipe://') || endpoint.startsWith('unix://')) return endpoint;
  if (!endpoint.startsWith('tcp://')) {
    throw new Error(`Refusing non-local Docker endpoint: ${endpoint}`);
  }
  const parsed = new URL(endpoint);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    throw new Error(`Refusing non-loopback Docker endpoint: ${endpoint}`);
  }
  return endpoint;
}

/** Permit DB access only through this run's private Docker aliases or loopback. */
export function assertSafeDatabaseHost(host, plan) {
  const normalized = String(host ?? '').trim().toLowerCase();
  const generatedAliases = new Set(Object.values(plan.aliases).map((value) => value.toLowerCase()));
  if (generatedAliases.has(normalized) || ['localhost', '127.0.0.1', '::1'].includes(normalized)) {
    return normalized;
  }
  throw new Error(`Refusing external database target: ${host}`);
}

/** Ensure every identifier used by SQL or cleanup belongs to the generated plan. */
export function assertSafeResourcePlan(plan) {
  if (!GENERATED_ID_PATTERN.test(plan.id)) throw new Error('Generated run id is unsafe.');
  const dockerNames = [
    plan.network,
    ...Object.values(plan.volumes),
    ...Object.values(plan.containers),
    ...Object.values(plan.aliases),
  ];
  for (const resource of dockerNames) {
    if (!resource.startsWith(`${plan.prefix}-`)) {
      throw new Error(`Refusing unowned Docker resource name: ${resource}`);
    }
    if (resource === 'calibrate-e2e-postgres') {
      throw new Error('The existing calibrate-e2e-postgres container is never owned by this drill.');
    }
  }
  for (const identifier of Object.values(plan.database)) {
    if (!GENERATED_SQL_NAME_PATTERN.test(identifier)) {
      throw new Error(`Refusing unsafe generated SQL identifier: ${identifier}`);
    }
  }
  if (plan.image !== `calibrate-backup-restore-smoke:${plan.id}`) {
    throw new Error(`Refusing unowned image name: ${plan.image}`);
  }
  return plan;
}

/** Return a redacted plan for reviewing the exact resources without contacting Docker. */
export function createDryRunPlan(id) {
  const plan = assertSafeResourcePlan(createResourcePlan(id));
  return {
    mode: 'dry-run',
    image: plan.image,
    postgresImage: POSTGRES_IMAGE,
    network: plan.network,
    volumes: Object.values(plan.volumes),
    containers: Object.values(plan.containers),
    sourceDatabase: plan.database.source,
    restoreDatabase: plan.database.restore,
    schema: plan.database.schema,
    safety: 'Only generated local Docker resources will be created or removed.',
  };
}

/** Seed the three irreplaceable tracking domains plus user timezone metadata. */
export function buildRepresentativeSeedSql(schemaName) {
  if (!GENERATED_SQL_NAME_PATTERN.test(schemaName) || schemaName.endsWith('_source') || schemaName.endsWith('_restore')) {
    throw new Error(`Refusing unsafe seed schema: ${schemaName}`);
  }
  const schema = `"${schemaName}"`;
  return `
CREATE SCHEMA ${schema};
CREATE TABLE ${schema}."User" (
  "id" text PRIMARY KEY,
  "email" text NOT NULL,
  "timezone" text NOT NULL,
  "language" text NOT NULL
);
CREATE TABLE ${schema}."FoodLog" (
  "id" integer PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES ${schema}."User"("id"),
  "occurred_at" timestamptz NOT NULL,
  "local_date" date NOT NULL,
  "meal_period" text NOT NULL,
  "name" text NOT NULL,
  "calories" integer NOT NULL
);
CREATE TABLE ${schema}."BodyMetric" (
  "id" integer PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES ${schema}."User"("id"),
  "date" date NOT NULL,
  "weight_grams" integer NOT NULL
);
CREATE TABLE ${schema}."ActivityRecord" (
  "id" integer PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES ${schema}."User"("id"),
  "started_at" timestamptz NOT NULL,
  "local_date" date NOT NULL,
  "activity_type" text NOT NULL,
  "steps" integer NOT NULL,
  "active_calories" integer NOT NULL
);
INSERT INTO ${schema}."User" VALUES
  ('backup-smoke-user', 'backup-smoke@calibratehealth.app', 'America/Los_Angeles', 'en');
INSERT INTO ${schema}."FoodLog" VALUES
  (1, 'backup-smoke-user', '2026-07-12T14:15:00Z', '2026-07-12', 'BREAKFAST', 'Oatmeal with blueberries', 320),
  (2, 'backup-smoke-user', '2026-07-13T02:10:00Z', '2026-07-12', 'DINNER', 'Chicken burrito bowl', 640);
INSERT INTO ${schema}."BodyMetric" VALUES
  (1, 'backup-smoke-user', '2026-07-12', 94710),
  (2, 'backup-smoke-user', '2026-07-13', 94347);
INSERT INTO ${schema}."ActivityRecord" VALUES
  (1, 'backup-smoke-user', '2026-07-12T15:00:00Z', '2026-07-12', 'STEPS', 8421, 376),
  (2, 'backup-smoke-user', '2026-07-13T01:30:00Z', '2026-07-12', 'WORKOUT', 1388, 241);
`;
}

/** Build one deterministic JSON value for exact source-versus-restore comparison. */
export function buildSnapshotSql(schemaName) {
  if (!GENERATED_SQL_NAME_PATTERN.test(schemaName) || schemaName.endsWith('_source') || schemaName.endsWith('_restore')) {
    throw new Error(`Refusing unsafe snapshot schema: ${schemaName}`);
  }
  const schema = `"${schemaName}"`;
  return `
SELECT jsonb_build_object(
  'counts', jsonb_build_object(
    'users', (SELECT count(*) FROM ${schema}."User"),
    'foodLogs', (SELECT count(*) FROM ${schema}."FoodLog"),
    'bodyMetrics', (SELECT count(*) FROM ${schema}."BodyMetric"),
    'activityRecords', (SELECT count(*) FROM ${schema}."ActivityRecord")
  ),
  'user', (SELECT to_jsonb(row) FROM (
    SELECT "id", "email", "timezone", "language" FROM ${schema}."User" ORDER BY "id"
  ) row),
  'foodLogs', (SELECT jsonb_agg(to_jsonb(row) ORDER BY "id") FROM (
    SELECT "id", "user_id", "occurred_at", "local_date", "meal_period", "name", "calories"
    FROM ${schema}."FoodLog" ORDER BY "id"
  ) row),
  'bodyMetrics', (SELECT jsonb_agg(to_jsonb(row) ORDER BY "id") FROM (
    SELECT "id", "user_id", "date", "weight_grams" FROM ${schema}."BodyMetric" ORDER BY "id"
  ) row),
  'activityRecords', (SELECT jsonb_agg(to_jsonb(row) ORDER BY "id") FROM (
    SELECT "id", "user_id", "started_at", "local_date", "activity_type", "steps", "active_calories"
    FROM ${schema}."ActivityRecord" ORDER BY "id"
  ) row)
)::text;
`;
}

/** Reject plaintext, partial, duplicate, or unexpected files in the backup volume. */
export function validateBackupManifest(fileNames) {
  const normalized = fileNames.map((file) => file.trim()).filter(Boolean).sort();
  const encrypted = normalized.filter((file) => BACKUP_FILE_PATTERN.test(file));
  if (encrypted.length !== 1 || normalized.length !== 2 || !normalized.includes('.last-success')) {
    throw new Error(`Backup volume contains unexpected files: ${normalized.join(', ') || '(none)'}`);
  }
  if (normalized.some((file) => file.endsWith('.dump') || file.endsWith('.partial'))) {
    throw new Error('Backup volume contains a plaintext or partial dump.');
  }
  return encrypted[0];
}

/** Check the expected representative rows before accepting source or restore data. */
export function validateRepresentativeSnapshot(snapshot) {
  assert.deepEqual(snapshot.counts, {
    users: 1,
    foodLogs: 2,
    bodyMetrics: 2,
    activityRecords: 2,
  });
  assert.equal(snapshot.user.email, 'backup-smoke@calibratehealth.app');
  assert.equal(snapshot.user.timezone, 'America/Los_Angeles');
  assert.deepEqual(snapshot.foodLogs.map((row) => [row.name, row.calories]), [
    ['Oatmeal with blueberries', 320],
    ['Chicken burrito bowl', 640],
  ]);
  assert.deepEqual(snapshot.bodyMetrics.map((row) => row.weight_grams), [94710, 94347]);
  assert.deepEqual(snapshot.activityRecords.map((row) => [row.activity_type, row.steps, row.active_calories]), [
    ['STEPS', 8421, 376],
    ['WORKOUT', 1388, 241],
  ]);
  return snapshot;
}

function defaultDockerRunner(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeoutMs ?? 120_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const details = (result.stderr || result.stdout || '').trim();
    throw new Error(`docker ${args.join(' ')} failed (${result.status ?? 1})${details ? `:\n${details}` : '.'}`);
  }
  return result;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function inspectDockerEndpoint(dockerRunner) {
  if (process.env.DOCKER_HOST) assertLocalDockerEndpoint(process.env.DOCKER_HOST);
  const result = dockerRunner(['context', 'inspect']);
  const contexts = JSON.parse(result.stdout);
  const endpoint = contexts?.[0]?.Endpoints?.docker?.Host;
  return assertLocalDockerEndpoint(endpoint);
}

/** Abort before mutation when any generated name already belongs to another Docker resource. */
export function assertNoResourceCollisions(dockerRunner, plan) {
  const lookups = [
    ...Object.values(plan.containers).map((name) => ['container', name]),
    ...Object.values(plan.volumes).map((name) => ['volume', name]),
    ['network', plan.network],
    ['image', plan.image],
  ];
  for (const [kind, name] of lookups) {
    const inspection = inspectDockerResourceOwnership(dockerRunner, kind, name, plan.id);
    if (inspection.state === 'owned' || inspection.state === 'foreign') {
      throw new Error(`Refusing generated-name collision with existing Docker ${kind}: ${name}`);
    }
    if (inspection.state === 'inspect-error') {
      throw new Error(`Unable to verify Docker ${kind} name is unused: ${name}: ${inspection.detail}`);
    }
  }
}

/** Ignore the image's temporary init server and wait for the final post-init server startup. */
export function hasPostgresInitializationCompleted(logResult) {
  return `${logResult.stdout}\n${logResult.stderr}`.includes(POSTGRES_INIT_COMPLETE_MARKER);
}

async function waitForPostgres(dockerRunner, container, user, database) {
  const deadline = Date.now() + POSTGRES_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const logs = dockerRunner(['logs', container], { allowFailure: true, timeoutMs: 10_000 });
    const initializationCompleted = hasPostgresInitializationCompleted(logs);
    if (initializationCompleted) {
      const result = dockerRunner(
        ['exec', container, 'pg_isready', '--username', user, '--dbname', database],
        { allowFailure: true, timeoutMs: 10_000 }
      );
      if (result.status === 0) return;
    }
    await delay(500);
  }
  throw new Error(`Postgres container ${container} did not become ready.`);
}

async function waitForBackup(dockerRunner, backupContainer) {
  const deadline = Date.now() + BACKUP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = dockerRunner(
      ['exec', backupContainer, 'test', '-f', '/backups/.last-success'],
      { allowFailure: true, timeoutMs: 10_000 }
    );
    if (result.status === 0) return;
    const state = dockerRunner(
      ['inspect', '--format', '{{.State.Running}}', backupContainer],
      { allowFailure: true, timeoutMs: 10_000 }
    );
    if (state.status !== 0 || state.stdout.trim() !== 'true') {
      const logs = dockerRunner(['logs', backupContainer], { allowFailure: true }).stdout.trim();
      throw new Error(`Backup container exited before success.${logs ? `\n${logs}` : ''}`);
    }
    await delay(500);
  }
  const logs = dockerRunner(['logs', backupContainer], { allowFailure: true }).stdout.trim();
  throw new Error(`Encrypted backup did not complete within ${BACKUP_READY_TIMEOUT_MS / 1000}s.${logs ? `\n${logs}` : ''}`);
}

function runPsql(dockerRunner, container, user, database, sql) {
  return dockerRunner(
    ['exec', '--interactive', container, 'psql', '--username', user, '--dbname', database, '--set', 'ON_ERROR_STOP=1'],
    { input: sql }
  ).stdout;
}

function readSnapshot(dockerRunner, container, user, database, schema) {
  const result = dockerRunner([
    'exec', container, 'psql', '--username', user, '--dbname', database,
    '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', buildSnapshotSql(schema),
  ]);
  return validateRepresentativeSnapshot(JSON.parse(result.stdout.trim()));
}

/** Build the isolated Postgres launch command, including the no-persistence tmpfs mount. */
export function buildPostgresRunArgs({ container, alias, network, database, user, password, ownerId }) {
  return [
    'run', '--detach', '--name', container,
    '--label', `${OWNERSHIP_LABEL}=${ownerId}`,
    '--network', network, '--network-alias', alias,
    // Override the image VOLUME so disposable database files cannot survive as anonymous volumes.
    '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=256m',
    '--env', `POSTGRES_DB=${database}`,
    '--env', `POSTGRES_USER=${user}`,
    '--env', `POSTGRES_PASSWORD=${password}`,
    POSTGRES_IMAGE,
  ];
}

function startPostgres(dockerRunner, options) {
  dockerRunner(buildPostgresRunArgs(options));
}

function createOwnedVolume(dockerRunner, plan, volume, createdVolumes) {
  // Track before mutation so ambiguous Docker failures are still reconciled during cleanup.
  createdVolumes.add(volume);
  dockerRunner([
    'volume', 'create', '--label', `${OWNERSHIP_LABEL}=${plan.id}`, volume,
  ]);
  const inspected = JSON.parse(dockerRunner(['volume', 'inspect', volume]).stdout);
  if (inspected?.[0]?.Labels?.[OWNERSHIP_LABEL] !== plan.id) {
    throw new Error(`Refusing cleanup ownership of Docker volume without this run's label: ${volume}`);
  }
}

function dockerInspectDetail(result) {
  return String(result.stderr || result.stdout || `inspect exited ${result.status ?? 'without a status'}`).trim();
}

/** Recognize only Docker's resource-specific missing messages; daemon failures remain errors. */
function isMissingDockerResource(kind, name, result) {
  const detail = dockerInspectDetail(result).toLowerCase();
  const target = name.toLowerCase();
  if (!detail.includes(target)) return false;
  if (kind === 'container') {
    return detail.includes(`no such object: ${target}`) || detail.includes(`no such container: ${target}`);
  }
  if (kind === 'image') {
    return detail.includes(`no such object: ${target}`) || detail.includes(`no such image: ${target}`);
  }
  if (kind === 'volume') return detail.includes('no such volume');
  if (kind === 'network') {
    return detail.includes(`network ${target} not found`) || detail.includes(`no such network: ${target}`);
  }
  return false;
}

/** Classify tracked resources without treating daemon errors or changed labels as absence. */
export function inspectDockerResourceOwnership(dockerRunner, kind, name, ownerId) {
  const result = dockerRunner([kind, 'inspect', name], { allowFailure: true, timeoutMs: 10_000 });
  if (result.status !== 0) {
    return isMissingDockerResource(kind, name, result)
      ? { state: 'absent' }
      : { state: 'inspect-error', detail: dockerInspectDetail(result) };
  }
  let inspected;
  try {
    inspected = JSON.parse(result.stdout);
  } catch (error) {
    return {
      state: 'inspect-error',
      detail: `invalid inspect JSON: ${error instanceof Error ? error.message : error}`
    };
  }
  const labels = kind === 'container' || kind === 'image'
    ? inspected?.[0]?.Config?.Labels
    : inspected?.[0]?.Labels;
  const actualOwner = labels?.[OWNERSHIP_LABEL];
  return actualOwner === ownerId
    ? { state: 'owned' }
    : {
        state: 'foreign',
        detail: `expected ${OWNERSHIP_LABEL}=${ownerId}, found ${actualOwner ?? 'no ownership label'}`
      };
}

/** Removes only smoke-test resources whose ownership labels still match this run, retaining cleanup failures. */
export function cleanupGeneratedResources(dockerRunner, plan, created) {
  const failures = [];
  const removeOwned = (kind, name, removeArgs) => {
    try {
      const before = inspectDockerResourceOwnership(dockerRunner, kind, name, plan.id);
      if (before.state === 'absent') return;
      if (before.state !== 'owned') {
        failures.push(`${kind} ${name} is ${before.state}: ${before.detail}`);
        return;
      }
      const removal = dockerRunner(removeArgs, { allowFailure: true, timeoutMs: 30_000 });
      const after = inspectDockerResourceOwnership(dockerRunner, kind, name, plan.id);
      if (after.state === 'absent') return;
      const removalDetail = removal.status === 0 ? '' : `; removal failed: ${dockerInspectDetail(removal)}`;
      if (after.state === 'owned') {
        failures.push(`${kind} ${name} still exists after cleanup${removalDetail}`);
      } else {
        failures.push(`${kind} ${name} became ${after.state}: ${after.detail}${removalDetail}`);
      }
    } catch (error) {
      failures.push(`${kind} ${name}: ${error instanceof Error ? error.message : error}`);
    }
  };

  // Only successful creations are tracked, and every removal rechecks the ownership label.
  for (const container of created.containers) {
    removeOwned('container', container, ['rm', '--force', container]);
  }
  for (const volume of created.volumes) {
    removeOwned('volume', volume, ['volume', 'rm', '--force', volume]);
  }
  if (created.network) removeOwned('network', plan.network, ['network', 'rm', plan.network]);
  if (created.image) removeOwned('image', plan.image, ['image', 'rm', '--force', plan.image]);

  if (failures.length > 0) {
    throw new Error(`Backup/restore smoke cleanup failed:\n- ${failures.join('\n- ')}`);
  }
}

/** Execute an encrypted backup and clean-database restore using the production shell scripts. */
export async function runBackupRestoreSmoke({ dryRun = false, id, dockerRunner = defaultDockerRunner } = {}) {
  const plan = assertSafeResourcePlan(createResourcePlan(id));
  if (dryRun) return createDryRunPlan(plan.id);

  inspectDockerEndpoint(dockerRunner);
  assertSafeDatabaseHost(plan.aliases.source, plan);
  assertSafeDatabaseHost(plan.aliases.restore, plan);
  assertNoResourceCollisions(dockerRunner, plan);
  const password = crypto.randomBytes(24).toString('base64url');
  const startedAt = Date.now();
  const created = {
    containers: new Set(),
    volumes: new Set(),
    network: false,
    image: false,
  };

  try {
    created.network = true;
    dockerRunner([
      'network', 'create', '--internal', '--label', `${OWNERSHIP_LABEL}=${plan.id}`, plan.network,
    ]);
    createOwnedVolume(dockerRunner, plan, plan.volumes.backups, created.volumes);
    createOwnedVolume(dockerRunner, plan, plan.volumes.identity, created.volumes);
    console.log(`[backup-restore-smoke] Building ${plan.image} from deploy/backup.`);
    created.image = true;
    dockerRunner([
      'build', '--label', `${OWNERSHIP_LABEL}=${plan.id}`, '--tag', plan.image, backupBuildContext,
    ], { timeoutMs: 180_000 });

    created.containers.add(plan.containers.source);
    startPostgres(dockerRunner, {
      container: plan.containers.source,
      alias: plan.aliases.source,
      network: plan.network,
      database: plan.database.source,
      user: plan.database.user,
      password,
      ownerId: plan.id,
    });
    created.containers.add(plan.containers.restore);
    startPostgres(dockerRunner, {
      container: plan.containers.restore,
      alias: plan.aliases.restore,
      network: plan.network,
      database: plan.database.restore,
      user: plan.database.user,
      password,
      ownerId: plan.id,
    });
    await Promise.all([
      waitForPostgres(dockerRunner, plan.containers.source, plan.database.user, plan.database.source),
      waitForPostgres(dockerRunner, plan.containers.restore, plan.database.user, plan.database.restore),
    ]);

    runPsql(
      dockerRunner,
      plan.containers.source,
      plan.database.user,
      plan.database.source,
      buildRepresentativeSeedSql(plan.database.schema)
    );
    const sourceSnapshot = readSnapshot(
      dockerRunner,
      plan.containers.source,
      plan.database.user,
      plan.database.source,
      plan.database.schema
    );

    created.containers.add(plan.containers.identity);
    dockerRunner([
      'run', '--rm', '--name', plan.containers.identity,
      '--label', `${OWNERSHIP_LABEL}=${plan.id}`,
      '--mount', `type=volume,source=${plan.volumes.identity},target=/identity`,
      plan.image, 'age-keygen', '--output', '/identity/identity.txt',
    ]);
    created.containers.delete(plan.containers.identity);
    created.containers.add(plan.containers.recipient);
    const recipient = dockerRunner([
      'run', '--rm', '--name', plan.containers.recipient,
      '--label', `${OWNERSHIP_LABEL}=${plan.id}`,
      '--mount', `type=volume,source=${plan.volumes.identity},target=/identity,readonly`,
      plan.image, 'age-keygen', '-y', '/identity/identity.txt',
    ]).stdout.trim();
    created.containers.delete(plan.containers.recipient);
    if (!recipient.startsWith('age1')) throw new Error('age-keygen did not return a public recipient.');

    dockerRunner([
      'run', '--detach', '--name', plan.containers.backup,
      '--label', `${OWNERSHIP_LABEL}=${plan.id}`,
      '--network', plan.network,
      '--mount', `type=volume,source=${plan.volumes.backups},target=/backups`,
      '--env', `DB_HOST=${plan.aliases.source}`,
      '--env', 'DB_PORT=5432',
      '--env', `DB_NAME=${plan.database.source}`,
      '--env', `DB_USER=${plan.database.user}`,
      '--env', `DB_PASSWORD=${password}`,
      '--env', 'PGSSLMODE=disable',
      '--env', `BACKUP_AGE_RECIPIENT=${recipient}`,
      '--env', 'BACKUP_INTERVAL_SECONDS=86400',
      '--env', 'BACKUP_RETRY_SECONDS=5',
      '--env', 'BACKUP_RETENTION_DAYS=1',
      plan.image, '/usr/local/bin/backup-postgres.sh',
    ]);
    created.containers.add(plan.containers.backup);
    await waitForBackup(dockerRunner, plan.containers.backup);

    const manifest = dockerRunner([
      'exec', plan.containers.backup, 'find', '/backups', '-maxdepth', '1', '-type', 'f', '-exec', 'basename', '{}', ';',
    ]).stdout.split(/\r?\n/);
    const encryptedFile = validateBackupManifest(manifest);
    const encryptedHeader = dockerRunner([
      'exec', plan.containers.backup, 'sh', '-c', 'head -c 21 "$1"', 'smoke', `/backups/${encryptedFile}`,
    ]).stdout;
    if (encryptedHeader !== 'age-encryption.org/v1') {
      throw new Error('Backup artifact is not an age-encrypted file.');
    }
    dockerRunner(['rm', '--force', plan.containers.backup]);
    created.containers.delete(plan.containers.backup);

    created.containers.add(plan.containers.restoreJob);
    dockerRunner([
      'run', '--rm', '--name', plan.containers.restoreJob,
      '--label', `${OWNERSHIP_LABEL}=${plan.id}`,
      '--network', plan.network,
      '--mount', `type=volume,source=${plan.volumes.backups},target=/backups,readonly`,
      '--mount', `type=volume,source=${plan.volumes.identity},target=/identity,readonly`,
      '--env', `DB_HOST=${plan.aliases.restore}`,
      '--env', 'DB_PORT=5432',
      '--env', `DB_NAME=${plan.database.restore}`,
      '--env', `DB_USER=${plan.database.user}`,
      '--env', `DB_PASSWORD=${password}`,
      '--env', 'PGSSLMODE=disable',
      '--env', `RESTORE_FILE=/backups/${encryptedFile}`,
      '--env', 'AGE_IDENTITY_FILE=/identity/identity.txt',
      '--env', 'CONFIRM_RESTORE_TO_EMPTY_DATABASE=RESTORE',
      plan.image, '/usr/local/bin/restore-postgres.sh',
    ], { timeoutMs: 120_000 });
    created.containers.delete(plan.containers.restoreJob);

    const restoredSnapshot = readSnapshot(
      dockerRunner,
      plan.containers.restore,
      plan.database.user,
      plan.database.restore,
      plan.database.schema
    );
    assert.deepEqual(restoredSnapshot, sourceSnapshot);
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[backup-restore-smoke] PASS in ${durationSeconds}s: encrypted ${encryptedFile}, restored and matched ` +
      '1 user, 2 food logs, 2 body metrics, and 2 activity records.'
    );
    return { encryptedFile, durationSeconds: Number(durationSeconds), plan: createDryRunPlan(plan.id) };
  } finally {
    cleanupGeneratedResources(dockerRunner, plan, created);
  }
}

function parseArguments(argumentsList) {
  const supported = new Set(['--dry-run']);
  for (const argument of argumentsList) {
    if (!supported.has(argument)) throw new Error(`Unknown argument: ${argument}`);
  }
  return { dryRun: argumentsList.includes('--dry-run') };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await runBackupRestoreSmoke(options);
    if (options.dryRun) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`[backup-restore-smoke] FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
