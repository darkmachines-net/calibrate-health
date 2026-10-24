#!/usr/bin/env node
/** @file Disposable database rollback rehearsal with explicit migration boundaries and owned cleanup. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertLocalDockerEndpoint,
  cleanupGeneratedResources,
  hasPostgresInitializationCompleted,
  inspectDockerResourceOwnership,
  validateBackupManifest,
} from './postgres-backup-restore-smoke.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const backendDirectory = path.join(repositoryRoot, 'backend');
const prismaDirectory = path.join(backendDirectory, 'prisma');
const migrationsDirectory = path.join(prismaDirectory, 'migrations');
const backupBuildContext = path.join(repositoryRoot, 'deploy', 'backup');
const backendRequire = createRequire(path.join(backendDirectory, 'package.json'));

export const ROLLBACK_BASE = Object.freeze({
  tag: 'v0.14.0',
  commit: '190e55c625fe106c2c85a7439b60a5a02f4257be',
  version: '0.14.0',
  migrationCount: 35,
  lastMigration: '0031_calibration_insights',
  ledgerSha256: '80165f5680e7fe93541a59d4bac0317f8233a7f160bcedac033f3c78c1876a38',
});

export const ROLLBACK_CANDIDATE = Object.freeze({
  migrationCount: 49,
  lastMigration: '0046_daily_calorie_plans',
  ledgerSha256: 'e041a546e5243957400314a749a092cd268573a0ffe05392cf84c9c297a2594d',
});

export const ROLLBACK_RESULT_PATH = path.join(
  repositoryRoot,
  '.codex-screenshots',
  'postgres-rollback-smoke',
  'result.json',
);

const POSTGRES_IMAGE = 'postgres:16-alpine';
// Reuse the backup/restore helper's ownership label so its verified cleanup path can prove ownership.
const OWNERSHIP_LABEL = 'com.calibrate.backup-restore-smoke';
const GENERATED_ID_PATTERN = /^[a-f0-9]{12}$/;
const GENERATED_SCHEMA_PATTERN = /^calibrate_rollback_[a-f0-9]{12}$/;
const GENERATED_DATABASE_PATTERN = /^calibrate_rollback_(?:source|restore)_[a-f0-9]{12}$/;
const GENERATED_USER_PATTERN = /^calibrate_rollback_user_[a-f0-9]{12}$/;
const TEMPORARY_BASE_PATTERN = /^calibrate-rollback-base-[A-Za-z0-9_-]+$/;
const BACKUP_READY_TIMEOUT_MS = 60_000;
const POSTGRES_READY_TIMEOUT_MS = 45_000;
const RETENTION_SENTINEL = 'calibrate-20000101T000000Z.dump.age';

function expectedResourcePlan(id) {
  const prefix = `calibrate-rb-smoke-${id}`;
  return {
    id,
    prefix,
    image: `calibrate-postgres-rollback-smoke:${id}`,
    network: `${prefix}-network`,
    volumes: {
      backups: `${prefix}-backups`,
      identity: `${prefix}-identity`,
    },
    containers: {
      source: `${prefix}-source-db`,
      restore: `${prefix}-restore-db`,
      identity: `${prefix}-identity-job`,
      recipient: `${prefix}-recipient-job`,
      retention: `${prefix}-retention-job`,
      backup: `${prefix}-backup-job`,
      restoreJob: `${prefix}-restore-job`,
    },
    aliases: {
      source: `${prefix}-source`,
      restore: `${prefix}-restore`,
    },
    database: {
      source: `calibrate_rollback_source_${id}`,
      restore: `calibrate_rollback_restore_${id}`,
      user: `calibrate_rollback_user_${id}`,
      schema: `calibrate_rollback_${id}`,
    },
  };
}

/** Generate names that can be proven to belong only to this disposable run. */
export function createRollbackResourcePlan(id = crypto.randomBytes(6).toString('hex')) {
  if (!GENERATED_ID_PATTERN.test(id)) {
    throw new Error(`Refusing unsafe rollback-smoke id: ${id}`);
  }
  return expectedResourcePlan(id);
}

/** Refuse any plan whose names were changed after generation. */
export function assertSafeRollbackResourcePlan(plan) {
  if (!GENERATED_ID_PATTERN.test(plan?.id ?? '')) {
    throw new Error('Rollback-smoke plan has an unsafe id.');
  }
  const expected = expectedResourcePlan(plan.id);
  assert.deepEqual(plan, expected, 'Rollback-smoke resource plan must match generated ownership names.');
  if (!GENERATED_SCHEMA_PATTERN.test(plan.database.schema)) {
    throw new Error(`Refusing unsafe rollback schema: ${plan.database.schema}`);
  }
  if (!GENERATED_DATABASE_PATTERN.test(plan.database.source)
      || !GENERATED_DATABASE_PATTERN.test(plan.database.restore)) {
    throw new Error('Rollback-smoke databases must use generated source/restore names.');
  }
  if (!GENERATED_USER_PATTERN.test(plan.database.user)) {
    throw new Error(`Refusing unsafe rollback database user: ${plan.database.user}`);
  }
  return plan;
}

/** Require Docker to publish exactly one loopback-only port. */
export function parseLoopbackPublishedPort(rawOutput) {
  const lines = String(rawOutput ?? '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error('Disposable Postgres must expose exactly one loopback port.');
  }
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(lines[0]);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Refusing non-loopback or invalid published Postgres endpoint: ${lines[0] || '(none)'}`);
  }
  return port;
}

/** Construct a URL only for a generated database through its loopback-published port. */
export function databaseUrlForRollbackTarget(plan, target, port, password) {
  assertSafeRollbackResourcePlan(plan);
  if (target !== 'source' && target !== 'restore') {
    throw new Error(`Unknown rollback database target: ${target}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid rollback database port: ${port}`);
  }
  if (typeof password !== 'string' || password.length < 24) {
    throw new Error('Rollback database password must be generated and at least 24 characters.');
  }
  const url = new URL('postgresql://127.0.0.1');
  url.username = plan.database.user;
  url.password = password;
  url.port = String(port);
  url.pathname = `/${plan.database[target]}`;
  url.searchParams.set('schema', plan.database.schema);
  return url.toString();
}

/** Reject caller-supplied, remote, or cross-run connection URLs. */
export function assertOwnedRollbackDatabaseUrl(rawUrl, plan, target) {
  assertSafeRollbackResourcePlan(plan);
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('Rollback database URL must use PostgreSQL.');
  }
  if (parsed.hostname !== '127.0.0.1') {
    throw new Error(`Refusing non-loopback rollback database host: ${parsed.hostname}`);
  }
  if (!/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535) {
    throw new Error('Rollback database URL must include a valid loopback port.');
  }
  if (decodeURIComponent(parsed.username) !== plan.database.user
      || parsed.pathname !== `/${plan.database[target]}`
      || parsed.searchParams.get('schema') !== plan.database.schema
      || !parsed.password) {
    throw new Error('Rollback database URL does not belong to the generated resource plan.');
  }
  return parsed;
}

/** Hashes the ordered migration ledger into a deterministic fingerprint. */
export function ledgerFingerprint(migrationNames) {
  return crypto.createHash('sha256').update(`${migrationNames.join('\n')}\n`).digest('hex');
}

/** Validate exact immutable-base and frozen-candidate migration ledgers. */
export function validateMigrationContract({ baseNames, candidateNames, baseCommit, baseVersion }) {
  assert.equal(baseCommit, ROLLBACK_BASE.commit, 'v0.14.0 tag does not resolve to the reviewed commit.');
  assert.equal(baseVersion, ROLLBACK_BASE.version, 'v0.14.0 release manifest version changed.');
  assert.equal(baseNames.length, ROLLBACK_BASE.migrationCount);
  assert.equal(baseNames.at(-1), ROLLBACK_BASE.lastMigration);
  assert.equal(ledgerFingerprint(baseNames), ROLLBACK_BASE.ledgerSha256);
  assert.equal(candidateNames.length, ROLLBACK_CANDIDATE.migrationCount);
  assert.equal(candidateNames.at(-1), ROLLBACK_CANDIDATE.lastMigration);
  assert.equal(ledgerFingerprint(candidateNames), ROLLBACK_CANDIDATE.ledgerSha256);
  assert.deepEqual(candidateNames.slice(0, baseNames.length), baseNames);
  return { baseNames, candidateNames };
}

/** Bind hosted evidence to the explicitly selected release-source commit. */
export function assertRollbackSourceCommit(candidateCommit, rawSourceCommit) {
  if (!/^[a-f0-9]{40}$/.test(candidateCommit)) {
    throw new Error('Candidate checkout did not resolve to a lowercase full Git commit.');
  }
  const sourceCommit = String(rawSourceCommit ?? '').trim();
  if (!sourceCommit) return candidateCommit;
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error('CALIBRATE_SOURCE_COMMIT must be a lowercase full Git SHA.');
  }
  if (sourceCommit !== candidateCommit) {
    throw new Error('CALIBRATE_SOURCE_COMMIT does not match the rollback candidate checkout.');
  }
  return candidateCommit;
}

/** Resolve the actual checkout before any retained result is written. */
export function resolveRollbackSourceCommit(
  commandRunner = defaultCommandRunner,
  environment = process.env,
) {
  const candidateCommit = gitText(commandRunner, ['rev-parse', 'HEAD']);
  return assertRollbackSourceCommit(candidateCommit, environment.CALIBRATE_SOURCE_COMMIT);
}

/** Accepts only generated rollback-test schema names before returning a quoted SQL identifier. */
export function assertSafeRollbackSchema(schemaName) {
  if (!GENERATED_SCHEMA_PATTERN.test(schemaName)) {
    throw new Error(`Refusing unsafe rollback schema: ${schemaName}`);
  }
  return `"${schemaName}"`;
}

/** Remove credentials and host paths before emitting any diagnostic or evidence. */
export function sanitizeRollbackDiagnostic(value, redactions = []) {
  let sanitized = String(value ?? '');
  for (const secret of redactions) {
    if (typeof secret === 'string' && secret) sanitized = sanitized.replaceAll(secret, '[redacted]');
  }
  return sanitized
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, 'postgresql://[redacted]@')
    .replace(/(DB_PASSWORD|POSTGRES_PASSWORD|PGPASSWORD)=[^\s]+/gi, '$1=[redacted]')
    .replace(/[A-Za-z]:\\[^\r\n"']+/g, '[redacted-path]')
    .replace(/\/(?:home|tmp|Users)\/[^\r\n"']+/g, '[redacted-path]')
    .slice(-4_000);
}

/** Builds rollback evidence only for an exact candidate and a completed encrypted backup artifact. */
export function createRollbackEvidence({ candidateCommit, durationSeconds, encryptedFile, reupgraded }) {
  if (!/^[a-f0-9]{40}$/.test(candidateCommit)) {
    throw new Error('Candidate commit must be a full Git SHA.');
  }
  if (!/^calibrate-\d{8}T\d{6}Z\.dump\.age$/.test(encryptedFile)) {
    throw new Error('Rollback evidence requires one completed encrypted backup filename.');
  }
  return {
    schema_version: 1,
    scope: 'postgres-rollback-smoke',
    status: 'passed',
    base: {
      tag: ROLLBACK_BASE.tag,
      commit: ROLLBACK_BASE.commit,
      migration_count: ROLLBACK_BASE.migrationCount,
      last_migration: ROLLBACK_BASE.lastMigration,
      ledger_sha256: ROLLBACK_BASE.ledgerSha256,
    },
    candidate: {
      commit: candidateCommit,
      migration_count: ROLLBACK_CANDIDATE.migrationCount,
      last_migration: ROLLBACK_CANDIDATE.lastMigration,
      ledger_sha256: ROLLBACK_CANDIDATE.ledgerSha256,
    },
    backup: {
      format: 'age-encrypted-postgres-custom-dump',
      file: encryptedFile,
      plaintext_artifacts: 0,
      completed_encrypted_artifacts: 1,
      retention_sentinel_removed: true,
    },
    checks: {
      base_seed_verified: true,
      candidate_upgrade_verified: true,
      representative_data_retained: true,
      restore_target_was_empty: true,
      restored_base_ledger_verified: true,
      restored_base_data_verified: true,
      restored_candidate_reupgrade_verified: Boolean(reupgraded),
    },
    duration_seconds: durationSeconds,
  };
}

/** Rejects all external targets and arguments so rollback smoke remains confined to its owned environment. */
export function parseRollbackArguments(argumentsList) {
  if (argumentsList.length !== 0) {
    throw new Error('postgres-rollback-smoke accepts no arguments or external database target.');
  }
  return {};
}

/** Preserves an explicit command encoding override and otherwise uses UTF-8. */
export function resolveCommandEncoding(options = {}) {
  return Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8';
}

function defaultCommandRunner(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: resolveCommandEncoding(options),
    env: options.env ?? process.env,
    input: options.input,
    timeout: options.timeoutMs ?? 120_000,
    windowsHide: true,
  });
}

function commandResult(commandRunner, command, args, options = {}) {
  const result = commandRunner(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const rawDetail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
    const detail = sanitizeRollbackDiagnostic(rawDetail, options.redactions);
    throw new Error(`${options.label ?? command} failed with exit code ${result.status ?? 1}${detail ? `:\n${detail}` : '.'}`);
  }
  return result;
}

function createDockerRunner(commandRunner) {
  return (args, options = {}) => commandResult(commandRunner, 'docker', args, {
    ...options,
    label: options.label ?? 'Docker rollback operation',
  });
}

function gitText(commandRunner, args, options = {}) {
  return String(commandResult(commandRunner, 'git', args, {
    ...options,
    label: options.label ?? 'Git rollback contract check',
  }).stdout).trim();
}

function gitBuffer(commandRunner, args) {
  return commandResult(commandRunner, 'git', args, {
    encoding: null,
    label: 'Git immutable-base content check',
  }).stdout;
}

/** Lists candidate migration directory names in deterministic lexical order. */
export function discoverCandidateMigrationNames(directory = migrationsDirectory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function inspectImmutableMigrationContract(commandRunner) {
  const tagReference = `refs/tags/${ROLLBACK_BASE.tag}`;
  const tagType = gitText(commandRunner, ['cat-file', '-t', tagReference]);
  assert.equal(tagType, 'tag', `${ROLLBACK_BASE.tag} must remain an annotated tag.`);
  const baseCommit = gitText(commandRunner, ['rev-parse', `${tagReference}^{}`]);
  const baseRelease = JSON.parse(gitText(commandRunner, [
    'show', `${tagReference}^{}:shared/release.json`,
  ]));
  const baseTreeEntries = gitText(commandRunner, [
    'ls-tree', '--name-only', `${tagReference}^{}:backend/prisma/migrations`,
  ]).split(/\r?\n/).filter(Boolean);
  const baseNames = baseTreeEntries.filter((entry) => entry !== 'migration_lock.toml');
  const candidateNames = discoverCandidateMigrationNames();

  validateMigrationContract({
    baseNames,
    candidateNames,
    baseCommit,
    baseVersion: baseRelease?.server?.version,
  });

  const ancestor = commandResult(commandRunner, 'git', [
    'merge-base', '--is-ancestor', baseCommit, 'HEAD',
  ], { allowFailure: true, label: 'Git base ancestry check' });
  if (ancestor.status !== 0) {
    throw new Error(`${ROLLBACK_BASE.tag} is not an ancestor of the candidate checkout.`);
  }
  const status = gitText(commandRunner, ['status', '--porcelain', '--untracked-files=all']);
  if (status) throw new Error('Rollback rehearsal requires a clean candidate checkout.');
  const candidateCommit = resolveRollbackSourceCommit(commandRunner);

  return { baseNames, candidateNames, candidateCommit, tagReference };
}

function assertOwnedTemporaryBaseRoot(temporaryRoot) {
  const resolvedRoot = path.resolve(temporaryRoot);
  const temporaryDirectory = path.resolve(os.tmpdir());
  const relative = path.relative(temporaryDirectory, resolvedRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)
      || !TEMPORARY_BASE_PATTERN.test(path.basename(resolvedRoot))) {
    throw new Error('Refusing unowned rollback migration temporary directory.');
  }
  return resolvedRoot;
}

function createImmutableBaseMigrationTree(contract, commandRunner) {
  const temporaryRoot = assertOwnedTemporaryBaseRoot(
    fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-rollback-base-')),
  );
  const temporaryPrismaDirectory = path.join(temporaryRoot, 'prisma');
  const temporaryMigrationsDirectory = path.join(temporaryPrismaDirectory, 'migrations');
  fs.mkdirSync(temporaryMigrationsDirectory, { recursive: true });
  fs.copyFileSync(
    path.join(prismaDirectory, 'schema.prisma'),
    path.join(temporaryPrismaDirectory, 'schema.prisma'),
  );

  const lockRelativePath = 'backend/prisma/migrations/migration_lock.toml';
  const immutableLock = gitBuffer(commandRunner, [
    'show', `${contract.tagReference}^{}:${lockRelativePath}`,
  ]);
  const currentLock = fs.readFileSync(path.join(migrationsDirectory, 'migration_lock.toml'));
  assert.deepEqual(currentLock, immutableLock, 'Migration lock differs from immutable v0.14.0.');
  fs.writeFileSync(path.join(temporaryMigrationsDirectory, 'migration_lock.toml'), immutableLock);

  for (const migrationName of contract.baseNames) {
    const relativeSqlPath = `backend/prisma/migrations/${migrationName}/migration.sql`;
    const immutableSql = gitBuffer(commandRunner, [
      'show', `${contract.tagReference}^{}:${relativeSqlPath}`,
    ]);
    const currentSql = fs.readFileSync(path.join(migrationsDirectory, migrationName, 'migration.sql'));
    assert.deepEqual(
      currentSql,
      immutableSql,
      `Historical migration ${migrationName} differs from immutable ${ROLLBACK_BASE.tag}.`,
    );
    const destinationDirectory = path.join(temporaryMigrationsDirectory, migrationName);
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(path.join(destinationDirectory, 'migration.sql'), immutableSql);
  }
  return {
    temporaryRoot,
    schemaPath: path.join(temporaryPrismaDirectory, 'schema.prisma'),
  };
}

function removeImmutableBaseMigrationTree(temporaryRoot) {
  if (!temporaryRoot) return;
  fs.rmSync(assertOwnedTemporaryBaseRoot(temporaryRoot), { recursive: true, force: true });
}
function inspectLocalDockerEndpoint(dockerRunner) {
  if (process.env.DOCKER_HOST) assertLocalDockerEndpoint(process.env.DOCKER_HOST);
  const result = dockerRunner(['context', 'inspect']);
  const contexts = JSON.parse(result.stdout);
  return assertLocalDockerEndpoint(contexts?.[0]?.Endpoints?.docker?.Host);
}

function assertNoRollbackResourceCollisions(dockerRunner, plan) {
  const resources = [
    ...Object.values(plan.containers).map((name) => ['container', name]),
    ...Object.values(plan.volumes).map((name) => ['volume', name]),
    ['network', plan.network],
    ['image', plan.image],
  ];
  for (const [kind, name] of resources) {
    const inspection = inspectDockerResourceOwnership(dockerRunner, kind, name, plan.id);
    if (inspection.state === 'absent') continue;
    if (inspection.state === 'inspect-error') {
      throw new Error(`Unable to prove generated Docker ${kind} name is unused: ${name}.`);
    }
    throw new Error(`Refusing generated-name collision with existing Docker ${kind}: ${name}.`);
  }
}

function assertDockerResourceOwned(dockerRunner, kind, name, plan) {
  const inspection = inspectDockerResourceOwnership(dockerRunner, kind, name, plan.id);
  if (inspection.state !== 'owned') {
    throw new Error(`Docker ${kind} ${name} is not owned by rollback run ${plan.id}.`);
  }
}

/**
 * Build a host-reachable bridge without allowing an omitted publish address to escape loopback.
 * Docker does not allocate published host ports for internal bridge networks, while Prisma and
 * the verification client intentionally run on the host for this cross-platform rehearsal.
 */
export function buildRollbackNetworkCreateArgs(plan) {
  assertSafeRollbackResourcePlan(plan);
  return [
    'network', 'create', '--driver', 'bridge',
    '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',
    '--label', `${OWNERSHIP_LABEL}=${plan.id}`,
    plan.network,
  ];
}

function createOwnedNetwork(dockerRunner, plan, created) {
  created.network = true;
  dockerRunner(buildRollbackNetworkCreateArgs(plan));
  assertDockerResourceOwned(dockerRunner, 'network', plan.network, plan);
}

function createOwnedVolume(dockerRunner, plan, volume, created) {
  created.volumes.add(volume);
  dockerRunner([
    'volume', 'create', '--label', `${OWNERSHIP_LABEL}=${plan.id}`, volume,
  ]);
  assertDockerResourceOwned(dockerRunner, 'volume', volume, plan);
}

/** Build the only accepted Postgres launch command for a generated rollback target. */
export function buildRollbackPostgresRunArgs({ plan, target, password }) {
  assertSafeRollbackResourcePlan(plan);
  if (target !== 'source' && target !== 'restore') throw new Error(`Unknown Postgres target: ${target}`);
  if (typeof password !== 'string' || password.length < 24) {
    throw new Error('Rollback Postgres password must be generated and at least 24 characters.');
  }
  return [
    'run', '--detach', '--name', plan.containers[target],
    '--label', `${OWNERSHIP_LABEL}=${plan.id}`,
    '--network', plan.network,
    '--network-alias', plan.aliases[target],
    '--publish', '127.0.0.1::5432',
    '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=512m',
    '--env', `POSTGRES_DB=${plan.database[target]}`,
    '--env', `POSTGRES_USER=${plan.database.user}`,
    '--env', `POSTGRES_PASSWORD=${password}`,
    POSTGRES_IMAGE,
  ];
}

function startRollbackPostgres(dockerRunner, plan, target, password, created) {
  const container = plan.containers[target];
  created.containers.add(container);
  dockerRunner(buildRollbackPostgresRunArgs({ plan, target, password }), {
    redactions: [password],
  });
  assertDockerResourceOwned(dockerRunner, 'container', container, plan);
  const portResult = dockerRunner(['port', container, '5432/tcp']);
  return parseLoopbackPublishedPort(portResult.stdout);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRollbackPostgres(dockerRunner, plan, target) {
  const container = plan.containers[target];
  const database = plan.database[target];
  const deadline = Date.now() + POSTGRES_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const logs = dockerRunner(['logs', container], { allowFailure: true, timeoutMs: 10_000 });
    if (hasPostgresInitializationCompleted(logs)) {
      const ready = dockerRunner([
        'exec', container, 'pg_isready',
        '--username', plan.database.user,
        '--dbname', database,
      ], { allowFailure: true, timeoutMs: 10_000 });
      if (ready.status === 0) return;
    }
    await delay(500);
  }
  throw new Error(`Disposable ${target} Postgres did not become ready.`);
}

function buildOwnedBackupImage(dockerRunner, plan, created) {
  created.image = true;
  dockerRunner([
    'build', '--label', `${OWNERSHIP_LABEL}=${plan.id}`,
    '--tag', plan.image,
    backupBuildContext,
  ], { timeoutMs: 180_000 });
  assertDockerResourceOwned(dockerRunner, 'image', plan.image, plan);
}

function runOwnedEphemeralContainer(dockerRunner, plan, created, container, args, options = {}) {
  created.containers.add(container);
  try {
    return dockerRunner([
      'run', '--rm', '--name', container,
      '--label', `${OWNERSHIP_LABEL}=${plan.id}`,
      ...args,
    ], options);
  } finally {
    const inspection = inspectDockerResourceOwnership(dockerRunner, 'container', container, plan.id);
    if (inspection.state === 'absent') created.containers.delete(container);
  }
}

function createAgeIdentity(dockerRunner, plan, created) {
  runOwnedEphemeralContainer(dockerRunner, plan, created, plan.containers.identity, [
    '--mount', `type=volume,source=${plan.volumes.identity},target=/identity`,
    plan.image,
    'age-keygen', '--output', '/identity/identity.txt',
  ]);
  const recipient = runOwnedEphemeralContainer(
    dockerRunner,
    plan,
    created,
    plan.containers.recipient,
    [
      '--mount', `type=volume,source=${plan.volumes.identity},target=/identity,readonly`,
      plan.image,
      'age-keygen', '-y', '/identity/identity.txt',
    ],
  ).stdout.trim();
  if (!/^age1[0-9a-z]+$/.test(recipient)) {
    throw new Error('age-keygen did not return a valid public recipient.');
  }
  return recipient;
}
function createRetentionSentinel(dockerRunner, plan, created) {
  runOwnedEphemeralContainer(dockerRunner, plan, created, plan.containers.retention, [
    '--mount', `type=volume,source=${plan.volumes.backups},target=/backups`,
    plan.image,
    'sh', '-c', `touch -t 200001010000 /backups/${RETENTION_SENTINEL}`,
  ]);
}

function startProductionBackup(dockerRunner, plan, password, recipient, created) {
  const container = plan.containers.backup;
  created.containers.add(container);
  dockerRunner([
    'run', '--detach', '--name', container,
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
    plan.image,
    '/usr/local/bin/backup-postgres.sh',
  ], { redactions: [password] });
  assertDockerResourceOwned(dockerRunner, 'container', container, plan);
}

async function waitForProductionBackup(dockerRunner, plan) {
  const container = plan.containers.backup;
  const deadline = Date.now() + BACKUP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const marker = dockerRunner([
      'exec', container, 'test', '-f', '/backups/.last-success',
    ], { allowFailure: true, timeoutMs: 10_000 });
    if (marker.status === 0) return;
    const running = dockerRunner([
      'inspect', '--format', '{{.State.Running}}', container,
    ], { allowFailure: true, timeoutMs: 10_000 });
    if (running.status !== 0 || running.stdout.trim() !== 'true') {
      throw new Error('Production backup container exited before writing its success marker.');
    }
    await delay(500);
  }
  throw new Error('Production encrypted backup did not complete within 60 seconds.');
}

function verifyEncryptedBackup(dockerRunner, plan) {
  const container = plan.containers.backup;
  const manifest = dockerRunner([
    'exec', container, 'find', '/backups', '-maxdepth', '1', '-type', 'f',
    '-exec', 'basename', '{}', ';',
  ]).stdout.split(/\r?\n/);
  const encryptedFile = validateBackupManifest(manifest);
  const sentinel = dockerRunner([
    'exec', container, 'test', '!', '-e', `/backups/${RETENTION_SENTINEL}`,
  ], { allowFailure: true });
  if (sentinel.status !== 0) {
    throw new Error('Completed-backup retention did not remove the old owned sentinel.');
  }
  const encryptedHeader = dockerRunner([
    'exec', container, 'sh', '-c', 'head -c 21 "$1"', 'rollback-smoke',
    `/backups/${encryptedFile}`,
  ]).stdout;
  if (encryptedHeader !== 'age-encryption.org/v1') {
    throw new Error('Rollback backup artifact is not age encrypted.');
  }
  return encryptedFile;
}

function stopProductionBackup(dockerRunner, plan, created) {
  assertDockerResourceOwned(dockerRunner, 'container', plan.containers.backup, plan);
  dockerRunner(['rm', '--force', plan.containers.backup]);
  const inspection = inspectDockerResourceOwnership(
    dockerRunner,
    'container',
    plan.containers.backup,
    plan.id,
  );
  if (inspection.state !== 'absent') {
    throw new Error('Owned production backup container still exists after explicit shutdown.');
  }
  created.containers.delete(plan.containers.backup);
}

function restoreProductionBackup(dockerRunner, plan, password, encryptedFile, created) {
  runOwnedEphemeralContainer(dockerRunner, plan, created, plan.containers.restoreJob, [
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
    plan.image,
    '/usr/local/bin/restore-postgres.sh',
  ], { timeoutMs: 120_000, redactions: [password] });
}

function migrateDeploy(databaseUrl, schemaPath, commandRunner, redactions) {
  const prismaCli = path.join(backendDirectory, 'node_modules', 'prisma', 'build', 'index.js');
  if (!fs.existsSync(prismaCli)) {
    throw new Error('Prisma CLI is missing. Install backend dependencies before the rollback rehearsal.');
  }
  const result = commandResult(commandRunner, process.execPath, [
    prismaCli, 'migrate', 'deploy', '--schema', schemaPath,
  ], {
    cwd: backendDirectory,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeoutMs: 180_000,
    label: 'Prisma migration deployment',
    redactions,
  });
  return result.status;
}
export const ROLLBACK_SEED_EXPECTATIONS = Object.freeze({
  email: 'rollback-smoke@calibratehealth.app',
  localDate: '2026-07-10',
  foodName: 'Rollback smoke breakfast',
  savedFoodName: 'Rollback smoke oats',
  weightGrams: 88_200,
  recommendationFingerprint: 'rollback-smoke-model-3-input',
  mobileDeviceId: 'rollback-smoke-phone',
});

async function seedRepresentativeBaseData(client, schemaName) {
  const schema = assertSafeRollbackSchema(schemaName);
  const userResult = await client.query(
    `INSERT INTO ${schema}."User" (
      "email", "password_hash", "weight_unit", "height_unit", "timezone", "language",
      "reminder_log_weight_enabled", "reminder_log_food_enabled", "haptics_enabled",
      "date_of_birth", "sex", "height_mm", "activity_level"
    ) VALUES ($1, $2, 'KG', 'CM', 'America/Los_Angeles', 'en', true, true, true,
      $3, 'MALE', 1800, 'LIGHT') RETURNING "id"`,
    [ROLLBACK_SEED_EXPECTATIONS.email, 'synthetic-rollback-password-hash', '1985-06-15T00:00:00.000Z'],
  );
  const userId = userResult.rows[0].id;

  const savedFoodResult = await client.query(
    `INSERT INTO ${schema}."MyFood" (
      "user_id", "type", "name", "serving_size_quantity", "serving_unit_label",
      "calories_per_serving", "is_pinned", "updated_at"
    ) VALUES ($1, 'FOOD', $2, 1, 'bowl', 360, true, $3) RETURNING "id"`,
    [userId, ROLLBACK_SEED_EXPECTATIONS.savedFoodName, '2026-07-10T12:00:00.000Z'],
  );
  const savedFoodId = savedFoodResult.rows[0].id;

  const goalResult = await client.query(
    `INSERT INTO ${schema}."Goal" (
      "user_id", "start_weight_grams", "target_weight_grams", "daily_deficit", "created_at"
    ) VALUES ($1, 90000, 82000, 500, $2) RETURNING "id"`,
    [userId, '2026-07-01T12:00:00.000Z'],
  );
  const goalId = goalResult.rows[0].id;

  const metricResult = await client.query(
    `INSERT INTO ${schema}."BodyMetric" ("user_id", "date", "weight_grams", "body_fat_percent")
     VALUES ($1, $2, $3, 21.5) RETURNING "id"`,
    [userId, ROLLBACK_SEED_EXPECTATIONS.localDate, ROLLBACK_SEED_EXPECTATIONS.weightGrams],
  );
  const metricId = metricResult.rows[0].id;
  await client.query(
    `INSERT INTO ${schema}."BodyMetricTrend" (
      "metric_id", "user_id", "date", "trend_weight_grams", "trend_ci_lower_grams",
      "trend_ci_upper_grams", "trend_std_grams", "model_version", "computed_at"
    ) VALUES ($1, $2, $3, 88150, 87600, 88700, 281, 1, $4)`,
    [metricId, userId, ROLLBACK_SEED_EXPECTATIONS.localDate, '2026-07-11T06:00:00.000Z'],
  );
  await client.query(
    `INSERT INTO ${schema}."FoodLog" (
      "user_id", "my_food_id", "date", "local_date", "meal_period", "name", "calories",
      "servings_consumed", "serving_size_quantity_snapshot", "serving_unit_label_snapshot",
      "calories_per_serving_snapshot", "external_source", "external_id"
    ) VALUES ($1, $2, $3, $4, 'BREAKFAST', $5, 360, 1, 1, 'bowl', 360,
      'openfoodfacts', 'rollback-smoke-food')`,
    [
      userId,
      savedFoodId,
      '2026-07-10T15:00:00.000Z',
      ROLLBACK_SEED_EXPECTATIONS.localDate,
      ROLLBACK_SEED_EXPECTATIONS.foodName,
    ],
  );
  await client.query(
    `INSERT INTO ${schema}."FoodLogDay" (
      "user_id", "local_date", "status", "origin", "completed_at", "updated_at"
    ) VALUES ($1, $2, 'COMPLETE', 'USER', $3, $3)`,
    [userId, ROLLBACK_SEED_EXPECTATIONS.localDate, '2026-07-11T06:00:00.000Z'],
  );

  const sessionId = 'rollback-smoke-browser-session';
  await client.query(
    `INSERT INTO ${schema}."session_store" ("sid", "sess", "expire", "user_id")
     VALUES ($1, $2, $3, $4)`,
    [sessionId, { passport: { user: userId }, synthetic: true }, '2027-01-01T00:00:00.000Z', userId],
  );
  const mobileSessionResult = await client.query(
    `INSERT INTO ${schema}."MobileAuthSession" (
      "user_id", "device_id", "device_platform", "device_name", "access_token_hash",
      "refresh_token_hash", "access_expires_at", "refresh_expires_at", "last_used_at", "updated_at"
    ) VALUES ($1, $2, 'ANDROID_PHONE', 'Rollback smoke phone', $3, $4, $5, $6, $7, $7)
    RETURNING "id"`,
    [
      userId,
      ROLLBACK_SEED_EXPECTATIONS.mobileDeviceId,
      'a'.repeat(64),
      'b'.repeat(64),
      '2026-08-01T00:00:00.000Z',
      '2027-08-01T00:00:00.000Z',
      '2026-07-10T12:00:00.000Z',
    ],
  );
  const mobileSessionId = mobileSessionResult.rows[0].id;
  await client.query(
    `INSERT INTO ${schema}."PushSubscription" (
      "user_id", "session_sid", "endpoint", "p256dh", "auth", "last_sent_local_date", "updated_at"
    ) VALUES ($1, $2, $3, 'synthetic-p256dh', 'synthetic-auth', $4, $5)`,
    [
      userId,
      sessionId,
      'https://push.invalid/rollback-smoke',
      ROLLBACK_SEED_EXPECTATIONS.localDate,
      '2026-07-10T12:00:00.000Z',
    ],
  );
  await client.query(
    `INSERT INTO ${schema}."NativePushSubscription" (
      "user_id", "mobile_auth_session_id", "device_id", "platform", "provider", "token",
      "last_sent_local_date", "updated_at"
    ) VALUES ($1, $2, $3, 'ANDROID', 'EXPO', 'ExponentPushToken[rollback-smoke]', $4, $5)`,
    [
      userId,
      mobileSessionId,
      ROLLBACK_SEED_EXPECTATIONS.mobileDeviceId,
      ROLLBACK_SEED_EXPECTATIONS.localDate,
      '2026-07-10T12:00:00.000Z',
    ],
  );

  const recommendationResult = await client.query(
    `INSERT INTO ${schema}."CalibrationRecommendation" (
      "user_id", "source_goal_id", "input_fingerprint", "model_version", "as_of_local_date",
      "current_target_adjustment_kcal", "recommended_target_adjustment_kcal",
      "current_target_kcal", "recommended_target_kcal", "status", "result_snapshot"
    ) VALUES ($1, $2, $3, 3, $4, 0, -150, 2100, 1950, 'PENDING', $5) RETURNING "id"`,
    [
      userId,
      goalId,
      ROLLBACK_SEED_EXPECTATIONS.recommendationFingerprint,
      ROLLBACK_SEED_EXPECTATIONS.localDate,
      { source: 'synthetic-rollback-smoke', recommendation: -150 },
    ],
  );
  await client.query(
    `INSERT INTO ${schema}."CaloriePlanRevision" (
      "user_id", "source_goal_id", "recommendation_id", "target_adjustment_kcal", "effective_local_date"
    ) VALUES ($1, $2, $3, -150, $4)`,
    [userId, goalId, recommendationResult.rows[0].id, '2026-07-11'],
  );
}

async function queryRows(client, sql, params = []) {
  return (await client.query(sql, params)).rows;
}

async function readRepresentativeSnapshot(client, schemaName) {
  const schema = assertSafeRollbackSchema(schemaName);
  return {
    users: await queryRows(client, `SELECT "email", "weight_unit"::text, "height_unit"::text,
      "timezone", "language", "date_of_birth"::date::text AS "date_of_birth", "sex"::text,
      "height_mm", "activity_level"::text, "reminder_log_weight_enabled",
      "reminder_log_food_enabled", "haptics_enabled"
      FROM ${schema}."User" ORDER BY "id"`),
    goals: await queryRows(client, `SELECT "start_weight_grams", "target_weight_grams", "daily_deficit"
      FROM ${schema}."Goal" ORDER BY "id"`),
    metrics: await queryRows(client, `SELECT "date"::text, "weight_grams", "body_fat_percent"
      FROM ${schema}."BodyMetric" ORDER BY "id"`),
    trends: await queryRows(client, `SELECT "date"::text, "trend_weight_grams", "trend_ci_lower_grams",
      "trend_ci_upper_grams", "trend_std_grams", "model_version"
      FROM ${schema}."BodyMetricTrend" ORDER BY "metric_id"`),
    foods: await queryRows(client, `SELECT "local_date"::text, "meal_period"::text, "name", "calories",
      "servings_consumed", "serving_unit_label_snapshot", "external_source", "external_id"
      FROM ${schema}."FoodLog" ORDER BY "id"`),
    food_days: await queryRows(client, `SELECT "local_date"::text, "status"::text, "origin"::text
      FROM ${schema}."FoodLogDay" ORDER BY "id"`),
    saved_foods: await queryRows(client, `SELECT "type"::text, "name", "serving_size_quantity",
      "serving_unit_label", "calories_per_serving", "is_pinned"
      FROM ${schema}."MyFood" ORDER BY "id"`),
    browser_sessions: await queryRows(client, `SELECT "sid", "sess", "user_id"
      FROM ${schema}."session_store" ORDER BY "sid"`),
    mobile_sessions: await queryRows(client, `SELECT "device_id", "device_platform"::text, "device_name",
      "access_token_hash", "refresh_token_hash" FROM ${schema}."MobileAuthSession" ORDER BY "id"`),
    web_push: await queryRows(client, `SELECT "endpoint", "last_sent_local_date"::text
      FROM ${schema}."PushSubscription" ORDER BY "id"`),
    native_push: await queryRows(client, `SELECT "device_id", "provider"::text, "token",
      "last_sent_local_date"::text FROM ${schema}."NativePushSubscription" ORDER BY "id"`),
    recommendations: await queryRows(client, `SELECT "input_fingerprint", "model_version", "status"::text,
      "current_target_kcal", "recommended_target_kcal", "result_snapshot"
      FROM ${schema}."CalibrationRecommendation" ORDER BY "id"`),
    revisions: await queryRows(client, `SELECT "target_adjustment_kcal", "effective_local_date"::text
      FROM ${schema}."CaloriePlanRevision" ORDER BY "id"`),
  };
}

/** Asserts that the restored baseline retains the expected representative account and tracking data. */
export function validateBaseRepresentativeSnapshot(snapshot) {
  assert.equal(snapshot.users.length, 1);
  assert.equal(snapshot.users[0].email, ROLLBACK_SEED_EXPECTATIONS.email);
  assert.equal(snapshot.users[0].date_of_birth, '1985-06-15');
  assert.deepEqual(snapshot.goals, [{ start_weight_grams: 90000, target_weight_grams: 82000, daily_deficit: 500 }]);
  assert.equal(snapshot.metrics[0].weight_grams, ROLLBACK_SEED_EXPECTATIONS.weightGrams);
  assert.equal(snapshot.foods[0].name, ROLLBACK_SEED_EXPECTATIONS.foodName);
  assert.equal(snapshot.saved_foods[0].name, ROLLBACK_SEED_EXPECTATIONS.savedFoodName);
  assert.equal(snapshot.browser_sessions[0].sid, 'rollback-smoke-browser-session');
  assert.equal(snapshot.mobile_sessions[0].device_id, ROLLBACK_SEED_EXPECTATIONS.mobileDeviceId);
  assert.equal(snapshot.recommendations[0].input_fingerprint, ROLLBACK_SEED_EXPECTATIONS.recommendationFingerprint);
  assert.equal(snapshot.recommendations[0].status, 'PENDING');
  assert.equal(snapshot.web_push.length, 1);
  assert.equal(snapshot.native_push.length, 1);
  assert.equal(snapshot.revisions.length, 1);
  return snapshot;
}

/** Derives expected post-upgrade data by applying the reviewed recommendation invalidation to the baseline snapshot. */
export function expectedCandidateRepresentativeSnapshot(baseSnapshot) {
  return {
    ...baseSnapshot,
    recommendations: baseSnapshot.recommendations.map((recommendation) => ({
      ...recommendation,
      status: 'STALE',
    })),
  };
}
async function readMigrationLedger(client, schemaName) {
  const schema = assertSafeRollbackSchema(schemaName);
  const rows = await queryRows(client, `SELECT "migration_name" FROM ${schema}."_prisma_migrations"
    WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL ORDER BY "migration_name"`);
  return rows.map((row) => row.migration_name);
}

async function verifyCandidateSchema(client, schemaName, candidateNames) {
  const schema = assertSafeRollbackSchema(schemaName);
  assert.deepEqual(await readMigrationLedger(client, schemaName), candidateNames);
  const rows = await queryRows(client, `SELECT
    u."email_verified_at" IS NOT NULL AS "email_verified",
    u."onboarding_completed_at" IS NOT NULL AS "onboarding_completed",
    u."reminder_log_weight_minute" = 540 AS "weight_minute_default",
    u."reminder_log_food_minute" = 540 AS "food_minute_default",
    u."reminder_quiet_hours_start_minute" IS NULL AS "quiet_start_null",
    u."reminder_quiet_hours_end_minute" IS NULL AS "quiet_end_null",
    g."calorie_plan_review_status"::text = 'CLEAR' AS "goal_review_clear",
    g."calorie_plan_review_reason" IS NULL AS "goal_review_reason_null",
    r."calorie_plan_review_status"::text = 'CLEAR' AS "revision_review_clear",
    r."calorie_plan_review_reason" IS NULL AS "revision_review_reason_null",
    r."configured_daily_deficit" IS NULL AS "legacy_pace_inherits_goal",
    t."trend_rate_grams_per_day" IS NULL AS "trend_rate_null",
    t."trend_rate_std_grams_per_day" IS NULL AS "trend_rate_std_null",
    t."source_revision" IS NULL AS "source_revision_null",
    s."public_id" IS NOT NULL AS "browser_public_id",
    s."created_at" IS NOT NULL AS "browser_created_at",
    s."last_used_at" IS NOT NULL AS "browser_last_used_at",
    m."public_id" IS NOT NULL AS "mobile_public_id",
    p."last_sent_local_date" = $1::date AS "web_legacy_receipt_preserved",
    p."last_sent_weight_local_date" = p."last_sent_local_date" AS "web_weight_receipt_backfilled",
    p."last_sent_food_local_date" = p."last_sent_local_date" AS "web_food_receipt_backfilled",
    n."last_sent_local_date" = $1::date AS "native_legacy_receipt_preserved",
    n."last_sent_weight_local_date" = n."last_sent_local_date" AS "native_weight_receipt_backfilled",
    n."last_sent_food_local_date" = n."last_sent_local_date" AS "native_food_receipt_backfilled"
    FROM ${schema}."User" u
    JOIN ${schema}."Goal" g ON g."user_id" = u."id"
    JOIN ${schema}."BodyMetricTrend" t ON t."user_id" = u."id"
    JOIN ${schema}."session_store" s ON s."user_id" = u."id"
    JOIN ${schema}."MobileAuthSession" m ON m."user_id" = u."id"
    JOIN ${schema}."PushSubscription" p ON p."user_id" = u."id"
    JOIN ${schema}."NativePushSubscription" n ON n."user_id" = u."id"
    JOIN ${schema}."CaloriePlanRevision" r ON r."user_id" = u."id"`, [
    ROLLBACK_SEED_EXPECTATIONS.localDate,
  ]);
  assert.equal(rows.length, 1);
  for (const [check, passed] of Object.entries(rows[0])) {
    assert.equal(passed, true, `Candidate schema check failed: ${check}`);
  }
  const comparisonRows = await queryRows(client, `SELECT
    "comparison_target_kcal", "comparison_maintenance_kcal", "comparison_captured_at"
    FROM ${schema}."FoodLogDay"`);
  assert.ok(comparisonRows.length > 0, 'Legacy food-day fixture must survive upgrade.');
  for (const day of comparisonRows) {
    assert.deepEqual(day, {
      comparison_target_kcal: null, comparison_maintenance_kcal: null, comparison_captured_at: null,
    }, 'Legacy plan history must remain unknown after upgrade.');
  }
  const newTables = await queryRows(client, `SELECT "table_name" FROM information_schema.tables
    WHERE "table_schema" = $1 AND "table_name" = ANY($2::text[]) ORDER BY "table_name"`, [
    schemaName,
    ['AccountActionToken', 'LegalAcceptance', 'ServerSettings'],
  ]);
  assert.deepEqual(newTables.map((row) => row.table_name), [
    'AccountActionToken', 'LegalAcceptance', 'ServerSettings',
  ]);
  const indexRows = await queryRows(client, `SELECT "indexname" FROM pg_catalog.pg_indexes
    WHERE "schemaname" = $1 AND "indexname" = 'MyFood_user_id_is_pinned_normalized_name_id_idx'`,
  [schemaName]);
  assert.equal(indexRows.length, 1);
}

async function assertDatabaseHasNoUserTables(client) {
  const rows = await queryRows(client, `SELECT count(*)::integer AS "table_count"
    FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`);
  assert.equal(rows[0].table_count, 0, 'Restore target must be empty before production restore.');
}

async function withPgClient(databaseUrl, callback) {
  const { Client } = backendRequire('pg');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

function writeRollbackResult(result) {
  const resultDirectory = path.dirname(ROLLBACK_RESULT_PATH);
  const resolvedDirectory = path.resolve(resultDirectory);
  const expectedDirectory = path.resolve(repositoryRoot, '.codex-screenshots', 'postgres-rollback-smoke');
  if (resolvedDirectory !== expectedDirectory) {
    throw new Error('Rollback result path escaped its fixed evidence directory.');
  }
  fs.mkdirSync(resultDirectory, { recursive: true });
  const temporaryResult = path.join(resultDirectory, `result-${process.pid}.tmp`);
  fs.writeFileSync(temporaryResult, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryResult, ROLLBACK_RESULT_PATH);
}

/** Execute the exact v0.14.0 -> candidate -> encrypted restore -> candidate rehearsal. */
export async function runPostgresRollbackSmoke({ commandRunner = defaultCommandRunner } = {}) {
  const startedAt = Date.now();
  const plan = assertSafeRollbackResourcePlan(createRollbackResourcePlan());
  const dockerRunner = createDockerRunner(commandRunner);
  const password = crypto.randomBytes(32).toString('base64url');
  const redactions = [password, repositoryRoot];
  const created = {
    containers: new Set(),
    volumes: new Set(),
    network: false,
    image: false,
  };
  let temporaryRoot;
  let result;

  try {
    const contract = inspectImmutableMigrationContract(commandRunner);
    const baseTree = createImmutableBaseMigrationTree(contract, commandRunner);
    temporaryRoot = baseTree.temporaryRoot;
    redactions.push(baseTree.temporaryRoot, baseTree.schemaPath);

    inspectLocalDockerEndpoint(dockerRunner);
    assertNoRollbackResourceCollisions(dockerRunner, plan);
    createOwnedNetwork(dockerRunner, plan, created);
    createOwnedVolume(dockerRunner, plan, plan.volumes.backups, created);
    createOwnedVolume(dockerRunner, plan, plan.volumes.identity, created);
    buildOwnedBackupImage(dockerRunner, plan, created);

    const sourcePort = startRollbackPostgres(dockerRunner, plan, 'source', password, created);
    const restorePort = startRollbackPostgres(dockerRunner, plan, 'restore', password, created);
    await Promise.all([
      waitForRollbackPostgres(dockerRunner, plan, 'source'),
      waitForRollbackPostgres(dockerRunner, plan, 'restore'),
    ]);
    const sourceUrl = databaseUrlForRollbackTarget(plan, 'source', sourcePort, password);
    const restoreUrl = databaseUrlForRollbackTarget(plan, 'restore', restorePort, password);
    assertOwnedRollbackDatabaseUrl(sourceUrl, plan, 'source');
    assertOwnedRollbackDatabaseUrl(restoreUrl, plan, 'restore');
    redactions.push(sourceUrl, restoreUrl);

    console.log(`[postgres-rollback-smoke] Applying immutable ${ROLLBACK_BASE.tag} migration ledger.`);
    migrateDeploy(sourceUrl, baseTree.schemaPath, commandRunner, redactions);
    let baseSnapshot;
    await withPgClient(sourceUrl, async (client) => {
      await seedRepresentativeBaseData(client, plan.database.schema);
      baseSnapshot = validateBaseRepresentativeSnapshot(
        await readRepresentativeSnapshot(client, plan.database.schema),
      );
      assert.deepEqual(await readMigrationLedger(client, plan.database.schema), contract.baseNames);
    });

    const recipient = createAgeIdentity(dockerRunner, plan, created);
    createRetentionSentinel(dockerRunner, plan, created);
    startProductionBackup(dockerRunner, plan, password, recipient, created);
    await waitForProductionBackup(dockerRunner, plan);
    const encryptedFile = verifyEncryptedBackup(dockerRunner, plan);
    stopProductionBackup(dockerRunner, plan, created);

    console.log(`[postgres-rollback-smoke] Applying candidate migrations through ${ROLLBACK_CANDIDATE.lastMigration}.`);
    migrateDeploy(sourceUrl, path.join(prismaDirectory, 'schema.prisma'), commandRunner, redactions);
    const expectedCandidateSnapshot = expectedCandidateRepresentativeSnapshot(baseSnapshot);
    await withPgClient(sourceUrl, async (client) => {
      const upgradedSnapshot = await readRepresentativeSnapshot(client, plan.database.schema);
      assert.deepEqual(upgradedSnapshot, expectedCandidateSnapshot);
      await verifyCandidateSchema(client, plan.database.schema, contract.candidateNames);
    });

    await withPgClient(restoreUrl, assertDatabaseHasNoUserTables);
    console.log('[postgres-rollback-smoke] Restoring the encrypted predecessor backup into the owned empty target.');
    restoreProductionBackup(dockerRunner, plan, password, encryptedFile, created);
    await withPgClient(restoreUrl, async (client) => {
      const restoredBaseSnapshot = validateBaseRepresentativeSnapshot(
        await readRepresentativeSnapshot(client, plan.database.schema),
      );
      assert.deepEqual(restoredBaseSnapshot, baseSnapshot);
      assert.deepEqual(await readMigrationLedger(client, plan.database.schema), contract.baseNames);
    });

    console.log('[postgres-rollback-smoke] Re-applying the candidate ledger to the restored predecessor data.');
    migrateDeploy(restoreUrl, path.join(prismaDirectory, 'schema.prisma'), commandRunner, redactions);
    await withPgClient(restoreUrl, async (client) => {
      assert.deepEqual(
        await readRepresentativeSnapshot(client, plan.database.schema),
        expectedCandidateSnapshot,
      );
      await verifyCandidateSchema(client, plan.database.schema, contract.candidateNames);
    });

    const durationSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
    result = createRollbackEvidence({
      candidateCommit: contract.candidateCommit,
      durationSeconds,
      encryptedFile,
      reupgraded: true,
    });
  } finally {
    try {
      cleanupGeneratedResources(dockerRunner, plan, created);
    } finally {
      removeImmutableBaseMigrationTree(temporaryRoot);
    }
  }

  writeRollbackResult(result);
  console.log(
    `[postgres-rollback-smoke] PASS: restored ${ROLLBACK_BASE.tag}, verified its exact data/ledger, `
    + `and re-upgraded through ${ROLLBACK_CANDIDATE.lastMigration}.`,
  );
  return result;
}

/** Builds failed rollback evidence with an exact source identity and sanitized diagnostics. */
export function createFailedRollbackEvidence(error, candidateCommit) {
  return {
    schema_version: 1,
    scope: 'postgres-rollback-smoke',
    status: 'failed',
    base: { tag: ROLLBACK_BASE.tag, commit: ROLLBACK_BASE.commit },
    candidate: { commit: assertRollbackSourceCommit(candidateCommit, '') },
    error: sanitizeRollbackDiagnostic(error instanceof Error ? error.message : error, [repositoryRoot]),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let candidateCommit = null;
  try {
    parseRollbackArguments(process.argv.slice(2));
    candidateCommit = resolveRollbackSourceCommit();
    await runPostgresRollbackSmoke();
  } catch (error) {
    const sanitizedError = sanitizeRollbackDiagnostic(
      error instanceof Error ? error.message : error,
      [repositoryRoot],
    );
    if (candidateCommit) {
      const failedResult = createFailedRollbackEvidence(error, candidateCommit);
      try {
        writeRollbackResult(failedResult);
      } catch {
        // The sanitized stderr remains available when evidence storage itself is unavailable.
      }
    }
    console.error(`[postgres-rollback-smoke] FAIL: ${sanitizedError}`);
    process.exitCode = 1;
  }
}
