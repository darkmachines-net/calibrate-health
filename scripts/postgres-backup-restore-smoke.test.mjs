/** @file Regression coverage for postgres backup restore smoke: resource plan isolates every Docker and SQL resource. */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertLocalDockerEndpoint,
  assertNoResourceCollisions,
  assertSafeDatabaseHost,
  assertSafeResourcePlan,
  buildPostgresRunArgs,
  buildRepresentativeSeedSql,
  buildSnapshotSql,
  cleanupGeneratedResources,
  createDryRunPlan,
  createResourcePlan,
  hasPostgresInitializationCompleted,
  inspectDockerResourceOwnership,
  runBackupRestoreSmoke,
  validateBackupManifest,
  validateRepresentativeSnapshot,
} from './postgres-backup-restore-smoke.mjs';

const RUN_ID = '012345abcdef';

function missingInspectResult(args) {
  const kind = args[0];
  const target = args[2] ?? args[1];
  const message = kind === 'volume'
    ? `Error response from daemon: get ${target}: no such volume`
    : kind === 'network'
      ? `Error response from daemon: network ${target} not found`
      : `Error: No such object: ${target}`;
  return { status: 1, stdout: '', stderr: message };
}

test('resource plan isolates every Docker and SQL resource', () => {
  const plan = assertSafeResourcePlan(createResourcePlan(RUN_ID));
  const names = [
    plan.network,
    ...Object.values(plan.volumes),
    ...Object.values(plan.containers),
    ...Object.values(plan.aliases),
  ];
  assert(names.every((name) => name.startsWith(`${plan.prefix}-`)));
  assert(!names.includes('calibrate-e2e-postgres'));
  assert.equal(plan.database.schema, `calibrate_backup_restore_smoke_${RUN_ID}`);
  assert.throws(() => createResourcePlan('../unsafe'), /unsafe/);

  const unsafePlan = structuredClone(plan);
  unsafePlan.containers.source = 'calibrate-e2e-postgres';
  assert.throws(() => assertSafeResourcePlan(unsafePlan), /unowned|never owned/);
});

test('disposable Postgres containers use tmpfs instead of anonymous data volumes', () => {
  const plan = createResourcePlan(RUN_ID);
  const args = buildPostgresRunArgs({
    container: plan.containers.source,
    alias: plan.aliases.source,
    network: plan.network,
    database: plan.database.source,
    user: plan.database.user,
    password: 'fixture-password',
    ownerId: plan.id
  });

  const tmpfsIndex = args.indexOf('--tmpfs');
  assert.notEqual(tmpfsIndex, -1);
  assert.match(args[tmpfsIndex + 1], /^\/var\/lib\/postgresql\/data:/);
  assert.equal(args.includes('--volume'), false);
  assert.equal(args.includes('--mount'), false);
});

test('readiness ignores the temporary Postgres initialization server', () => {
  assert.equal(hasPostgresInitializationCompleted({
    stdout: 'database system is ready to accept connections',
    stderr: ''
  }), false);
  assert.equal(hasPostgresInitializationCompleted({
    stdout: '',
    stderr: 'PostgreSQL init process complete; ready for start up.\ndatabase system is ready'
  }), true);
});

test('preexisting generated-name collision aborts without deleting the colliding resource', async () => {
  const plan = createResourcePlan(RUN_ID);
  const calls = [];
  const dockerRunner = (args) => {
    calls.push(args);
    if (args[0] === 'context' && args[1] === 'inspect') {
      return {
        status: 0,
        stdout: JSON.stringify([{ Endpoints: { docker: { Host: 'npipe:////./pipe/docker_engine' } } }]),
        stderr: '',
      };
    }
    if (args[0] === 'volume' && args[1] === 'inspect' && args[2] === plan.volumes.backups) {
      return { status: 0, stdout: '[]', stderr: '' };
    }
    return missingInspectResult(args);
  };

  await assert.rejects(
    () => runBackupRestoreSmoke({ id: RUN_ID, dockerRunner }),
    /generated-name collision.*volume/
  );
  assert(calls.some((args) => args.join(' ') === `volume inspect ${plan.volumes.backups}`));
  assert(!calls.some((args) => args.includes('rm') || args.includes('create') || args.includes('build') || args.includes('run')));
});

test('collision helper checks all generated resource namespaces', () => {
  const plan = createResourcePlan(RUN_ID);
  const calls = [];
  assertNoResourceCollisions((args) => {
    calls.push(args);
    return missingInspectResult(args);
  }, plan);
  assert.equal(
    calls.length,
    Object.keys(plan.containers).length + Object.keys(plan.volumes).length + 2
  );
});

test('cleanup ownership distinguishes owned, foreign, absent, and inspect errors', () => {
  const plan = createResourcePlan(RUN_ID);
  const inspect = (labels, labelPath = 'Config') => (args) => ({
    status: 0,
    stdout: JSON.stringify([labelPath === 'Config' ? { Config: { Labels: labels } } : { Labels: labels }]),
    stderr: '',
    args,
  });
  const ownedLabel = { 'com.calibrate.backup-restore-smoke': plan.id };

  assert.equal(
    inspectDockerResourceOwnership(inspect(ownedLabel), 'container', plan.containers.source, plan.id).state,
    'owned'
  );
  assert.equal(
    inspectDockerResourceOwnership(inspect(ownedLabel, 'Labels'), 'volume', plan.volumes.backups, plan.id).state,
    'owned'
  );
  assert.equal(
    inspectDockerResourceOwnership(
      inspect({ 'com.calibrate.backup-restore-smoke': 'different-run' }),
      'image',
      plan.image,
      plan.id
    ).state,
    'foreign'
  );
  assert.equal(
    inspectDockerResourceOwnership(
      () => ({ status: 1, stdout: '', stderr: `Error response from daemon: network ${plan.network} not found` }),
      'network',
      plan.network,
      plan.id
    ).state,
    'absent'
  );
  assert.equal(
    inspectDockerResourceOwnership(
      () => ({ status: 1, stdout: '', stderr: 'error during connect: Docker daemon unavailable' }),
      'network',
      plan.network,
      plan.id
    ).state,
    'inspect-error'
  );
});

test('cleanup fails without deleting tracked resources whose ownership cannot be proven', () => {
  const plan = createResourcePlan(RUN_ID);
  const removals = [];
  const created = {
    containers: new Set([plan.containers.source]),
    volumes: new Set(),
    network: false,
    image: false
  };

  assert.throws(
    () => cleanupGeneratedResources((args) => {
      if (args[1] === 'inspect') {
        return {
          status: 0,
          stdout: JSON.stringify([{ Config: { Labels: {} } }]),
          stderr: ''
        };
      }
      removals.push(args);
      return { status: 0, stdout: '', stderr: '' };
    }, plan, created),
    /foreign.*no ownership label/
  );
  assert.deepEqual(removals, []);

  assert.throws(
    () => cleanupGeneratedResources(() => ({
      status: 1,
      stdout: '',
      stderr: 'error during connect: Docker daemon unavailable'
    }), plan, created),
    /inspect-error.*daemon unavailable/
  );
});

test('cleanup attempts every owned resource and fails when removals leave resources behind', () => {
  const plan = createResourcePlan(RUN_ID);
  const removals = [];
  const dockerRunner = (args) => {
    if (args[1] === 'inspect') {
      const labels = { 'com.calibrate.backup-restore-smoke': plan.id };
      const metadata = args[0] === 'container' || args[0] === 'image'
        ? { Config: { Labels: labels } }
        : { Labels: labels };
      return { status: 0, stdout: JSON.stringify([metadata]), stderr: '' };
    }
    removals.push(args.join(' '));
    return { status: 1, stdout: '', stderr: 'simulated refusal' };
  };
  const created = {
    containers: new Set([plan.containers.source]),
    volumes: new Set([plan.volumes.backups]),
    network: true,
    image: true
  };

  assert.throws(() => cleanupGeneratedResources(dockerRunner, plan, created), /cleanup failed/);
  assert.deepEqual(removals, [
    `rm --force ${plan.containers.source}`,
    `volume rm --force ${plan.volumes.backups}`,
    `network rm ${plan.network}`,
    `image rm --force ${plan.image}`
  ]);
});

test('Docker and database target guards reject external hosts', () => {
  assert.equal(assertLocalDockerEndpoint('npipe:////./pipe/docker_engine'), 'npipe:////./pipe/docker_engine');
  assert.equal(assertLocalDockerEndpoint('unix:///var/run/docker.sock'), 'unix:///var/run/docker.sock');
  assert.equal(assertLocalDockerEndpoint('tcp://127.0.0.1:2375'), 'tcp://127.0.0.1:2375');
  assert.throws(() => assertLocalDockerEndpoint('tcp://db.example.test:2375'), /non-loopback/);
  assert.throws(() => assertLocalDockerEndpoint('ssh://operator@example.test'), /non-local/);

  const plan = createResourcePlan(RUN_ID);
  assert.equal(assertSafeDatabaseHost(plan.aliases.source, plan), plan.aliases.source);
  assert.equal(assertSafeDatabaseHost('localhost', plan), 'localhost');
  assert.throws(() => assertSafeDatabaseHost('db.example.test', plan), /external database/);
});

test('seed and snapshot SQL accept only generated schema identifiers', () => {
  const plan = createResourcePlan(RUN_ID);
  const seed = buildRepresentativeSeedSql(plan.database.schema);
  assert.match(seed, /"FoodLog"/);
  assert.match(seed, /"BodyMetric"/);
  assert.match(seed, /"ActivityRecord"/);
  assert.match(seed, /America\/Los_Angeles/);
  assert.match(buildSnapshotSql(plan.database.schema), /jsonb_build_object/);
  assert.throws(() => buildRepresentativeSeedSql('public'), /unsafe seed schema/);
  assert.throws(() => buildSnapshotSql('public; DROP DATABASE postgres'), /unsafe snapshot schema/);
});

test('backup manifest allows exactly one encrypted dump and the success marker', () => {
  const encrypted = 'calibrate-20260713T120000Z.dump.age';
  assert.equal(validateBackupManifest(['.last-success', encrypted, '']), encrypted);
  assert.throws(
    () => validateBackupManifest(['.last-success', encrypted, 'calibrate-20260713T120000Z.dump']),
    /unexpected files|plaintext/
  );
  assert.throws(
    () => validateBackupManifest(['.last-success', `${encrypted}.partial`]),
    /unexpected files|partial/
  );
});

test('representative snapshot checks food, weight, and activity values', () => {
  const snapshot = {
    counts: { users: 1, foodLogs: 2, bodyMetrics: 2, activityRecords: 2 },
    user: {
      id: 'backup-smoke-user',
      email: 'backup-smoke@calibratehealth.app',
      timezone: 'America/Los_Angeles',
      language: 'en',
    },
    foodLogs: [
      { name: 'Oatmeal with blueberries', calories: 320 },
      { name: 'Chicken burrito bowl', calories: 640 },
    ],
    bodyMetrics: [{ weight_grams: 94710 }, { weight_grams: 94347 }],
    activityRecords: [
      { activity_type: 'STEPS', steps: 8421, active_calories: 376 },
      { activity_type: 'WORKOUT', steps: 1388, active_calories: 241 },
    ],
  };
  assert.equal(validateRepresentativeSnapshot(snapshot), snapshot);
  assert.throws(
    () => validateRepresentativeSnapshot({ ...snapshot, counts: { ...snapshot.counts, foodLogs: 1 } }),
    /Expected values to be strictly deep-equal/
  );
});

test('dry run produces a reviewable plan without invoking Docker', async () => {
  const dockerRunner = () => {
    throw new Error('Docker must not be called during dry run.');
  };
  const result = await runBackupRestoreSmoke({ dryRun: true, id: RUN_ID, dockerRunner });
  assert.deepEqual(result, createDryRunPlan(RUN_ID));
  assert.equal(result.mode, 'dry-run');
  assert(!JSON.stringify(result).includes('password'));
});
