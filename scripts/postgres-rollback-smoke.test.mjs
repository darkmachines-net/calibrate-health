/** @file Regression coverage for postgres rollback smoke: resource plan owns only generated Docker and database names. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ROLLBACK_BASE,
  ROLLBACK_CANDIDATE,
  ROLLBACK_RESULT_PATH,
  ROLLBACK_SEED_EXPECTATIONS,
  assertOwnedRollbackDatabaseUrl,
  assertRollbackSourceCommit,
  assertSafeRollbackResourcePlan,
  assertSafeRollbackSchema,
  buildRollbackNetworkCreateArgs,
  buildRollbackPostgresRunArgs,
  createFailedRollbackEvidence,
  createRollbackEvidence,
  createRollbackResourcePlan,
  databaseUrlForRollbackTarget,
  discoverCandidateMigrationNames,
  expectedCandidateRepresentativeSnapshot,
  ledgerFingerprint,
  parseLoopbackPublishedPort,
  parseRollbackArguments,
  resolveCommandEncoding,
  resolveRollbackSourceCommit,
  sanitizeRollbackDiagnostic,
  validateBaseRepresentativeSnapshot,
  validateMigrationContract,
} from './postgres-rollback-smoke.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const SCRIPT_PATH = path.join(scriptDirectory, 'postgres-rollback-smoke.mjs');
const RUN_ID = '012345abcdef';
const PASSWORD = 'rollback-smoke-password-000000000000';

test('resource plan owns only generated Docker and database names', () => {
  const plan = assertSafeRollbackResourcePlan(createRollbackResourcePlan(RUN_ID));
  assert.equal(plan.image, `calibrate-postgres-rollback-smoke:${RUN_ID}`);
  assert.equal(plan.database.source, `calibrate_rollback_source_${RUN_ID}`);
  assert.equal(plan.database.restore, `calibrate_rollback_restore_${RUN_ID}`);
  assert.equal(plan.database.schema, `calibrate_rollback_${RUN_ID}`);
  assert(Object.values(plan.containers).every((name) => name.startsWith(`${plan.prefix}-`)));
  assert(Object.values(plan.volumes).every((name) => name.startsWith(`${plan.prefix}-`)));
  assert.throws(() => createRollbackResourcePlan('../unsafe'), /unsafe rollback-smoke id/);

  const tampered = structuredClone(plan);
  tampered.containers.source = 'existing-production-db';
  assert.throws(() => assertSafeRollbackResourcePlan(tampered), /resource plan must match/);
});

test('published database ports must be loopback-only and singular', () => {
  assert.equal(parseLoopbackPublishedPort('127.0.0.1:49152\n'), 49152);
  assert.throws(() => parseLoopbackPublishedPort('0.0.0.0:49152'), /non-loopback/);
  assert.throws(() => parseLoopbackPublishedPort('[::]:49152'), /non-loopback/);
  assert.throws(
    () => parseLoopbackPublishedPort('127.0.0.1:49152\n127.0.0.1:49153'),
    /exactly one/,
  );
  assert.throws(() => parseLoopbackPublishedPort('127.0.0.1:70000'), /invalid/);
});

test('database URLs cannot escape the generated loopback target', () => {
  const plan = createRollbackResourcePlan(RUN_ID);
  const sourceUrl = databaseUrlForRollbackTarget(plan, 'source', 49152, PASSWORD);
  const parsed = assertOwnedRollbackDatabaseUrl(sourceUrl, plan, 'source');
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, `/${plan.database.source}`);
  assert.equal(parsed.searchParams.get('schema'), plan.database.schema);

  const remote = new URL(sourceUrl);
  remote.hostname = 'db.example.com';
  assert.throws(
    () => assertOwnedRollbackDatabaseUrl(remote.toString(), plan, 'source'),
    /non-loopback/,
  );
  assert.throws(
    () => assertOwnedRollbackDatabaseUrl(sourceUrl, plan, 'restore'),
    /does not belong/,
  );
  assert.throws(
    () => databaseUrlForRollbackTarget(plan, 'source', 49152, 'short'),
    /at least 24/,
  );
});

test('Postgres launch is private, disposable, labeled, and loopback-published', () => {
  const plan = createRollbackResourcePlan(RUN_ID);
  const networkArgs = buildRollbackNetworkCreateArgs(plan);
  const args = buildRollbackPostgresRunArgs({ plan, target: 'source', password: PASSWORD });
  assert.deepEqual(networkArgs, [
    'network', 'create', '--driver', 'bridge',
    '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',
    '--label', 'com.calibrate.backup-restore-smoke=012345abcdef',
    plan.network,
  ]);
  assert(!networkArgs.includes('--internal'));
  assert.deepEqual(args.slice(0, 4), ['run', '--detach', '--name', plan.containers.source]);
  assert(args.includes('--tmpfs'));
  assert(args.includes('/var/lib/postgresql/data:rw,nosuid,size=512m'));
  assert(args.includes('--publish'));
  assert(args.includes('127.0.0.1::5432'));
  assert(args.includes(`POSTGRES_DB=${plan.database.source}`));
  assert(args.includes('com.calibrate.backup-restore-smoke=012345abcdef'));
  assert(!args.includes('5432:5432'));
});

test('migration contract pins exact v0.14.0 and candidate ledgers', () => {
  const candidateNames = discoverCandidateMigrationNames();
  const baseNames = candidateNames.slice(0, ROLLBACK_BASE.migrationCount);
  const contract = validateMigrationContract({
    baseNames,
    candidateNames,
    baseCommit: ROLLBACK_BASE.commit,
    baseVersion: ROLLBACK_BASE.version,
  });
  assert.equal(contract.baseNames.at(-1), '0031_calibration_insights');
  assert.equal(contract.candidateNames.at(-1), '0046_daily_calorie_plans');
  assert.equal(ledgerFingerprint(baseNames), ROLLBACK_BASE.ledgerSha256);
  assert.equal(ledgerFingerprint(candidateNames), ROLLBACK_CANDIDATE.ledgerSha256);

  assert.throws(() => validateMigrationContract({
    baseNames,
    candidateNames: candidateNames.slice(0, -1),
    baseCommit: ROLLBACK_BASE.commit,
    baseVersion: ROLLBACK_BASE.version,
  }));
  assert.throws(() => validateMigrationContract({
    baseNames,
    candidateNames,
    baseCommit: '0'.repeat(40),
    baseVersion: ROLLBACK_BASE.version,
  }));
});

test('hosted source binding accepts only the checked-out lowercase full SHA', () => {
  const candidate = '1'.repeat(40);
  assert.equal(assertRollbackSourceCommit(candidate, candidate), candidate);
  assert.equal(assertRollbackSourceCommit(candidate, ''), candidate);
  assert.throws(() => assertRollbackSourceCommit(candidate, '2'.repeat(40)), /does not match/);
  assert.throws(() => assertRollbackSourceCommit(candidate, 'A'.repeat(40)), /lowercase full Git SHA/);
  assert.throws(() => assertRollbackSourceCommit('short', candidate), /lowercase full Git commit/);
});
test('source resolver binds the actual checkout to the workflow candidate', () => {
  const candidate = '1'.repeat(40);
  const commandRunner = () => ({ status: 0, stdout: `${candidate}\n`, stderr: '' });
  assert.equal(
    resolveRollbackSourceCommit(commandRunner, { CALIBRATE_SOURCE_COMMIT: candidate }),
    candidate,
  );
  assert.throws(
    () => resolveRollbackSourceCommit(commandRunner, { CALIBRATE_SOURCE_COMMIT: '2'.repeat(40) }),
    /does not match/,
  );
});

test('representative snapshots distinguish base from the intentional candidate transform', () => {
  const baseSnapshot = {
    users: [{ email: ROLLBACK_SEED_EXPECTATIONS.email, date_of_birth: '1985-06-15' }],
    goals: [{ start_weight_grams: 90000, target_weight_grams: 82000, daily_deficit: 500 }],
    metrics: [{ weight_grams: ROLLBACK_SEED_EXPECTATIONS.weightGrams }],
    trends: [{}],
    foods: [{ name: ROLLBACK_SEED_EXPECTATIONS.foodName }],
    food_days: [{}],
    saved_foods: [{ name: ROLLBACK_SEED_EXPECTATIONS.savedFoodName }],
    browser_sessions: [{ sid: 'rollback-smoke-browser-session' }],
    mobile_sessions: [{ device_id: ROLLBACK_SEED_EXPECTATIONS.mobileDeviceId }],
    web_push: [{}],
    native_push: [{}],
    recommendations: [{
      input_fingerprint: ROLLBACK_SEED_EXPECTATIONS.recommendationFingerprint,
      status: 'PENDING',
    }],
    revisions: [{}],
  };
  validateBaseRepresentativeSnapshot(baseSnapshot);
  const candidateSnapshot = expectedCandidateRepresentativeSnapshot(baseSnapshot);
  assert.equal(candidateSnapshot.recommendations[0].status, 'STALE');
  assert.equal(baseSnapshot.recommendations[0].status, 'PENDING');
});

test('diagnostics redact credentials and absolute host paths', () => {
  const diagnostic = [
    'postgresql://rollback:super-secret@127.0.0.1:49152/db?schema=s',
    'DB_PASSWORD=super-secret',
    'C:\\Users\\release\\candidate\\schema.prisma',
    '/tmp/calibrate-rollback-base-secret/prisma/schema.prisma',
  ].join('\n');
  const sanitized = sanitizeRollbackDiagnostic(diagnostic, ['additional-secret']);
  assert.doesNotMatch(sanitized, /super-secret|C:\\Users|\/tmp\/calibrate/);
  assert.match(sanitized, /postgresql:\/\/\[redacted\]@/);
  assert.match(sanitized, /DB_PASSWORD=\[redacted\]/);
  assert.match(sanitized, /\[redacted-path\]/);
});

test('success evidence is sanitized, exact, and contains no resource target', () => {
  const evidence = createRollbackEvidence({
    candidateCommit: '1'.repeat(40),
    durationSeconds: 42.5,
    encryptedFile: 'calibrate-20260809T120000Z.dump.age',
    reupgraded: true,
  });
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.base.tag, 'v0.14.0');
  assert.equal(evidence.base.last_migration, '0031_calibration_insights');
  assert.equal(evidence.candidate.last_migration, '0046_daily_calorie_plans');
  assert.equal(evidence.checks.restored_candidate_reupgrade_verified, true);
  const encoded = JSON.stringify(evidence);
  assert.doesNotMatch(encoded, /password|127\.0\.0\.1|calibrate-rb-smoke|schema\.prisma/i);
  assert.throws(() => createRollbackEvidence({
    candidateCommit: 'short',
    durationSeconds: 1,
    encryptedFile: 'calibrate-20260809T120000Z.dump.age',
    reupgraded: true,
  }), /full Git SHA/);
});

test('failed evidence remains bound to the checked-out candidate', () => {
  const candidateCommit = '1'.repeat(40);
  const evidence = createFailedRollbackEvidence(new Error('synthetic failure'), candidateCommit);
  assert.deepEqual(evidence.candidate, { commit: candidateCommit });
  assert.equal(evidence.status, 'failed');
  assert.throws(
    () => createFailedRollbackEvidence(new Error('synthetic failure'), 'short'),
    /lowercase full Git commit/,
  );
});

test('schema names, arguments, and evidence path are fixed and guarded', () => {
  assert.equal(assertSafeRollbackSchema(`calibrate_rollback_${RUN_ID}`), `"calibrate_rollback_${RUN_ID}"`);
  assert.throws(() => assertSafeRollbackSchema('public'), /unsafe rollback schema/);
  assert.deepEqual(parseRollbackArguments([]), {});
  assert.throws(() => parseRollbackArguments(['--database-url', 'postgresql://remote']), /no arguments/);
  assert.equal(
    path.resolve(ROLLBACK_RESULT_PATH),
    path.join(repositoryRoot, '.codex-screenshots', 'postgres-rollback-smoke', 'result.json'),
  );
});

test('command encoding defaults to text while preserving explicit spawn encodings', () => {
  assert.equal(resolveCommandEncoding(), 'utf8');
  assert.equal(resolveCommandEncoding({ encoding: 'utf16le' }), 'utf16le');
  assert.equal(resolveCommandEncoding({ encoding: null }), null);
});

test('script contract uses production backup/restore and cleanup without external DATABASE_URL', () => {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.match(source, /\/usr\/local\/bin\/backup-postgres\.sh/);
  assert.match(source, /\/usr\/local\/bin\/restore-postgres\.sh/);
  assert.match(source, /CONFIRM_RESTORE_TO_EMPTY_DATABASE=RESTORE/);
  assert.match(source, /cleanupGeneratedResources\(dockerRunner, plan, created\)/);
  assert.match(
    source,
    /assertDockerResourceOwned\(dockerRunner, 'container', plan\.containers\.backup, plan\);\s+dockerRunner\(\['rm', '--force', plan\.containers\.backup\]\)/,
  );
  assert.match(source, /finally \{/);
  assert.match(source, /refs\/tags\/\$\{ROLLBACK_BASE\.tag\}/);
  assert.match(source, /environment\.CALIBRATE_SOURCE_COMMIT/);
  assert.match(source, /p\."last_sent_local_date" = \$1::date AS "web_legacy_receipt_preserved"/);
  assert.match(
    source,
    /p\."last_sent_weight_local_date" = p\."last_sent_local_date" AS "web_weight_receipt_backfilled"/,
  );
  assert.match(
    source,
    /p\."last_sent_food_local_date" = p\."last_sent_local_date" AS "web_food_receipt_backfilled"/,
  );
  assert.match(source, /n\."last_sent_local_date" = \$1::date AS "native_legacy_receipt_preserved"/);
  assert.match(
    source,
    /n\."last_sent_weight_local_date" = n\."last_sent_local_date" AS "native_weight_receipt_backfilled"/,
  );
  assert.match(
    source,
    /n\."last_sent_food_local_date" = n\."last_sent_local_date" AS "native_food_receipt_backfilled"/,
  );
  assert.doesNotMatch(source, /GITHUB_SHA/);
  assert.doesNotMatch(source, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(source, /v0\.13\.3/);
});
