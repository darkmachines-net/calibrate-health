#!/usr/bin/env node
/** @file Populated PostgreSQL migration upgrade rehearsal with data integrity and schema validation. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const backendDirectory = path.join(repositoryRoot, 'backend');
const prismaDirectory = path.join(backendDirectory, 'prisma');
const migrationsDirectory = path.join(prismaDirectory, 'migrations');
const backendRequire = createRequire(path.join(backendDirectory, 'package.json'));
const PRE_NATIVE_MIGRATION_ORDINAL = 20;
const ISOLATED_SCHEMA_PATTERN = /^calibrate_upgrade_smoke_[a-z0-9_]+$/;

/** Return a migration's four-digit ordinal, rejecting unexpected folder names. */
export function migrationOrdinal(migrationName) {
  const match = /^(\d{4})_/.exec(migrationName);
  if (!match) throw new Error(`Migration folder has no four-digit ordinal: ${migrationName}`);
  return Number(match[1]);
}

/** Build a connection URL that targets only the generated upgrade-smoke schema. */
export function databaseUrlForSchema(rawDatabaseUrl, schemaName) {
  if (!ISOLATED_SCHEMA_PATTERN.test(schemaName)) {
    throw new Error(`Refusing unsafe upgrade-smoke schema name: ${schemaName}`);
  }
  const databaseUrl = new URL(rawDatabaseUrl);
  if (databaseUrl.protocol !== 'postgresql:' && databaseUrl.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol.');
  }
  databaseUrl.searchParams.set('schema', schemaName);
  return databaseUrl.toString();
}

/** Discover tracked migrations in the same deterministic order Prisma uses. */
export function discoverMigrationNames(directory = migrationsDirectory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/** Copy the schema and only the legacy migration prefix into a disposable Prisma tree. */
export function createLegacyMigrationTree(migrationNames) {
  const legacyNames = migrationNames.filter(
    (migrationName) => migrationOrdinal(migrationName) <= PRE_NATIVE_MIGRATION_ORDINAL
  );
  assert(legacyNames.some((name) => name === '0020_goal_active_lookup_index'));
  assert(migrationNames.some((name) => migrationOrdinal(name) > PRE_NATIVE_MIGRATION_ORDINAL));

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-upgrade-'));
  const temporaryPrismaDirectory = path.join(temporaryRoot, 'prisma');
  const temporaryMigrationsDirectory = path.join(temporaryPrismaDirectory, 'migrations');
  fs.mkdirSync(temporaryMigrationsDirectory, { recursive: true });
  fs.copyFileSync(
    path.join(prismaDirectory, 'schema.prisma'),
    path.join(temporaryPrismaDirectory, 'schema.prisma')
  );
  fs.copyFileSync(
    path.join(migrationsDirectory, 'migration_lock.toml'),
    path.join(temporaryMigrationsDirectory, 'migration_lock.toml')
  );
  for (const migrationName of legacyNames) {
    fs.cpSync(
      path.join(migrationsDirectory, migrationName),
      path.join(temporaryMigrationsDirectory, migrationName),
      { recursive: true }
    );
  }
  return {
    legacyNames,
    schemaPath: path.join(temporaryPrismaDirectory, 'schema.prisma'),
    temporaryRoot,
  };
}

/** Apply migrations through Prisma's production deployment path. */
export function migrateDeploy(databaseUrl, schemaPath) {
  const prismaCli = path.join(backendDirectory, 'node_modules', 'prisma', 'build', 'index.js');
  if (!fs.existsSync(prismaCli)) {
    throw new Error('Prisma CLI is missing. Run npm --prefix backend ci before this smoke test.');
  }
  const result = spawnSync(
    process.execPath,
    [prismaCli, 'migrate', 'deploy', '--schema', schemaPath],
    {
      cwd: backendDirectory,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed with exit code ${result.status ?? 1}.`);
  }
}

/** Seed the legacy schema with the core records users cannot afford to lose. */
async function insertRepresentativeLegacyData(client, schemaName) {
  const schema = `"${schemaName}"`;
  const userResult = await client.query(
    `INSERT INTO ${schema}."User" (
      "email", "password_hash", "weight_unit", "height_unit", "timezone", "language",
      "date_of_birth", "sex", "height_mm", "activity_level"
    ) VALUES ($1, $2, 'LB', 'FT_IN', 'America/Los_Angeles', 'en', $3, 'MALE', 1803, 'MODERATE')
    RETURNING "id"`,
    ['upgrade-smoke@calibratehealth.app', 'representative-password-hash', new Date('1985-06-15T00:00:00Z')]
  );
  const userId = userResult.rows[0].id;

  await client.query(
    `INSERT INTO ${schema}."Goal" (
      "user_id", "start_weight_grams", "target_weight_grams", "daily_deficit", "created_at"
    ) VALUES ($1, 95254, 81647, 750, $2)`,
    [userId, new Date('2026-07-01T12:00:00Z')]
  );
  const metricResult = await client.query(
    `INSERT INTO ${schema}."BodyMetric" (
      "user_id", "date", "weight_grams", "body_fat_percent"
    ) VALUES ($1, $2, 94710, 24.5)
    RETURNING "id"`,
    [userId, '2026-07-10']
  );
  await client.query(
    `INSERT INTO ${schema}."BodyMetricTrend" (
      "metric_id", "user_id", "date", "trend_weight_grams",
      "trend_ci_lower_grams", "trend_ci_upper_grams", "trend_std_grams",
      "model_version", "computed_at"
    ) VALUES ($1, $2, $3, 94680, 93980, 95380, 357, 1, $4)`,
    [metricResult.rows[0].id, userId, '2026-07-10', new Date('2026-07-11T06:05:00Z')]
  );
  await client.query(
    `INSERT INTO ${schema}."FoodLog" (
      "user_id", "date", "local_date", "meal_period", "name", "calories",
      "servings_consumed", "calories_per_serving_snapshot", "external_source", "external_id"
    ) VALUES ($1, $2, $3, 'DINNER', 'Upgrade smoke burrito', 640, 1, 640, 'openfoodfacts', 'smoke-food-1')`,
    [userId, new Date('2026-07-11T02:30:00Z'), '2026-07-10']
  );
  await client.query(
    `INSERT INTO ${schema}."FoodLogDay" (
      "user_id", "local_date", "is_complete", "completed_at"
    ) VALUES
      ($1, '2026-07-10', true, $2),
      ($1, '2026-07-11', false, null)`,
    [userId, new Date('2026-07-11T06:00:00Z')]
  );
  return userId;
}

/** Exercise additive credential invariants on real synthetic SQL rows, then roll back all test writes. */
async function verifyCredentialFoundation(client, schema, userId) {
  await client.query('BEGIN');
  try {
    const initial = await client.query(`SELECT "password_hash", "credential_security_version" FROM ${schema}."User" WHERE "id" = $1`, [userId]);
    assert.deepEqual(initial.rows[0], { password_hash: 'representative-password-hash', credential_security_version: 0 });
    assert.equal((await client.query(`SELECT * FROM ${schema}."FirebaseIdentity"`)).rowCount, 0);
    await client.query(`INSERT INTO ${schema}."FirebaseIdentity" ("user_id", "installation_id", "source_id", "project_id", "uid")
      VALUES ($1, 'synthetic-install', 'synthetic-source', 'synthetic-project', 'synthetic-uid')`, [userId]);
    const rejected = async (sql, args, code) => {
      await client.query('SAVEPOINT credential_boundary');
      try { await assert.rejects(client.query(sql, args), (error) => error.code === code); }
      finally { await client.query('ROLLBACK TO SAVEPOINT credential_boundary'); }
    };
    await rejected(`UPDATE ${schema}."FirebaseIdentity" SET "uid" = 'changed-uid' WHERE "user_id" = $1`, [userId], 'P0001');
    await rejected(`DELETE FROM ${schema}."FirebaseIdentity" WHERE "user_id" = $1`, [userId], 'P0001');
    const second = await client.query(`INSERT INTO ${schema}."User" ("email", "password_hash") VALUES ('second-synthetic@example.invalid', 'synthetic') RETURNING "id"`);
    await rejected(`INSERT INTO ${schema}."FirebaseIdentity" ("user_id", "installation_id", "source_id", "project_id", "uid")
      VALUES ($1, 'synthetic-install', 'synthetic-source', 'synthetic-project', 'synthetic-uid')`, [second.rows[0].id], '23505');
    await client.query(`INSERT INTO ${schema}."FirebaseIdentity" ("user_id", "installation_id", "source_id", "project_id", "uid")
      VALUES ($1, 'synthetic-install', 'synthetic-source', 'synthetic-project', 'second-uid')`, [second.rows[0].id]);
    await client.query(`DELETE FROM ${schema}."User" WHERE "id" = $1`, [second.rows[0].id]);
    assert.equal((await client.query(`SELECT * FROM ${schema}."FirebaseIdentity" WHERE "user_id" = $1`, [second.rows[0].id])).rowCount, 0);
    const changed = await client.query(`UPDATE ${schema}."User" SET "password_hash" = 'synthetic-new-hash' WHERE "id" = $1 RETURNING "credential_security_version"`, [userId]);
    assert.equal(changed.rows[0].credential_security_version, 1);
    const unchanged = await client.query(`UPDATE ${schema}."User" SET "password_hash" = 'synthetic-new-hash' WHERE "id" = $1 RETURNING "credential_security_version"`, [userId]);
    assert.equal(unchanged.rows[0].credential_security_version, 1);
    await client.query(`UPDATE ${schema}."User" SET "credential_security_version" = "credential_security_version" + 1 WHERE "id" = $1`, [userId]);
    const stale = await client.query(`UPDATE ${schema}."User" SET "credential_security_version" = 1 WHERE "id" = $1 AND "credential_security_version" = 1`, [userId]);
    assert.equal(stale.rowCount, 0, 'Stale MCP approval must not acquire the account lock');
    await rejected(`UPDATE ${schema}."User" SET "credential_security_version" = 0 WHERE "id" = $1`, [userId], 'P0001');
    console.log('[db-upgrade-smoke] PASS: immutable mapping, local deletion cascade and monotonic credential security version.');
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Verify both retained user data and the native-client schema added after 0020. */
async function verifyUpgradedSchema(client, schemaName, userId, migrationNames) {
  const schema = `"${schemaName}"`;
  const retained = await client.query(
    `SELECT
      u."email", u."timezone", u."height_mm",
      g."start_weight_grams", g."target_weight_grams", g."daily_deficit",
      b."date"::text AS "metric_date", b."weight_grams", b."body_fat_percent",
      t."trend_weight_grams", t."trend_ci_lower_grams", t."trend_ci_upper_grams",
      t."trend_std_grams", t."trend_rate_grams_per_day",
      t."trend_rate_std_grams_per_day", t."model_version" AS "trend_model_version",
      t."source_revision" AS "trend_source_revision",
      f."local_date"::text AS "food_local_date", f."meal_period"::text AS "meal_period",
      f."name", f."calories", f."external_source", f."external_id"
    FROM ${schema}."User" u
    JOIN ${schema}."Goal" g ON g."user_id" = u."id"
    JOIN ${schema}."BodyMetric" b ON b."user_id" = u."id"
    JOIN ${schema}."BodyMetricTrend" t ON t."metric_id" = b."id"
    JOIN ${schema}."FoodLog" f ON f."user_id" = u."id"
    WHERE u."id" = $1`,
    [userId]
  );
  assert.equal(retained.rowCount, 1);
  assert.deepEqual(retained.rows[0], {
    email: 'upgrade-smoke@calibratehealth.app',
    timezone: 'America/Los_Angeles',
    height_mm: 1803,
    start_weight_grams: 95254,
    target_weight_grams: 81647,
    daily_deficit: 750,
    metric_date: '2026-07-10',
    weight_grams: 94710,
    body_fat_percent: 24.5,
    trend_weight_grams: 94680,
    trend_ci_lower_grams: 93980,
    trend_ci_upper_grams: 95380,
    trend_std_grams: 357,
    trend_rate_grams_per_day: null,
    trend_rate_std_grams_per_day: null,
    trend_model_version: 1,
    trend_source_revision: null,
    food_local_date: '2026-07-10',
    meal_period: 'DINNER',
    name: 'Upgrade smoke burrito',
    calories: 640,
    external_source: 'openfoodfacts',
    external_id: 'smoke-food-1',
  });

  const expectedNewTables = [
    'DailyCaloriePlan',
    'ActivityDaySummary',
    'ActivityRecord',
    'ClientOperation',
    'HealthConnectSyncState',
    'HealthConnectTombstone',
    'MobileAuthSession',
    'NativePushSubscription',
    'SyncChange',
    'WearPairingCredential',
    'FoodTrackingPause',
  ];
  const tableResult = await client.query(
    `SELECT "table_name" FROM information_schema.tables
     WHERE "table_schema" = $1 AND "table_name" = ANY($2::text[])
     ORDER BY "table_name"`,
    [schemaName, expectedNewTables]
  );
  assert.deepEqual(tableResult.rows.map((row) => row.table_name), [...expectedNewTables].sort());
  assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${schema}."DailyCaloriePlan"`)).rows[0].count, 0,
    'Upgrade must not manufacture historical daily plans');

  const columnResult = await client.query(
    `SELECT "column_name" FROM information_schema.columns
     WHERE "table_schema" = $1 AND "table_name" = 'MyFood' AND "column_name" = 'is_pinned'`,
    [schemaName]
  );
  assert.equal(columnResult.rowCount, 1);

  const foodDayResult = await client.query(
    `SELECT "local_date"::text AS "local_date", "status"::text AS "status",
      "origin"::text AS "origin", "completed_at"
    FROM ${schema}."FoodLogDay"
    WHERE "user_id" = $1
    ORDER BY "local_date"`,
    [userId]
  );
  assert.deepEqual(
    foodDayResult.rows.map((row) => ({
      ...row,
      completed_at: row.completed_at?.toISOString() ?? null,
    })),
    [
      {
        local_date: '2026-07-10',
        status: 'COMPLETE',
        origin: 'USER',
        completed_at: '2026-07-11T06:00:00.000Z',
      },
      {
        local_date: '2026-07-11',
        status: 'OPEN',
        origin: 'USER',
        completed_at: null,
      },
    ]
  );

  const appliedResult = await client.query(
    `SELECT "migration_name" FROM ${schema}."_prisma_migrations"
     WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
     ORDER BY "migration_name"`
  );
  assert.deepEqual(appliedResult.rows.map((row) => row.migration_name), migrationNames);
  await verifyCredentialFoundation(client, schema, userId);
}

/** Run a populated upgrade in a disposable schema and remove only that schema afterward. */
export async function runPopulatedUpgradeSmoke(rawDatabaseUrl = process.env.DATABASE_URL) {
  if (!rawDatabaseUrl) {
    throw new Error('DATABASE_URL is required for the populated Postgres upgrade smoke test.');
  }
  const migrationNames = discoverMigrationNames();
  const schemaName = `calibrate_upgrade_smoke_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  const databaseUrl = databaseUrlForSchema(rawDatabaseUrl, schemaName);
  const { Client } = backendRequire('pg');
  const adminClient = new Client({ connectionString: rawDatabaseUrl });
  let temporaryRoot;

  await adminClient.connect();
  try {
    // The generated and regex-validated identifier is the only object this test owns.
    await adminClient.query(`CREATE SCHEMA "${schemaName}"`);
    const legacyTree = createLegacyMigrationTree(migrationNames);
    temporaryRoot = legacyTree.temporaryRoot;

    console.log(`[db-upgrade-smoke] Applying ${legacyTree.legacyNames.length} migrations through 0020.`);
    migrateDeploy(databaseUrl, legacyTree.schemaPath);
    const userId = await insertRepresentativeLegacyData(adminClient, schemaName);

    console.log(`[db-upgrade-smoke] Applying migrations 0021-${migrationNames.at(-1)?.slice(0, 4)} to populated data.`);
    migrateDeploy(databaseUrl, path.join(prismaDirectory, 'schema.prisma'));
    await verifyUpgradedSchema(adminClient, schemaName, userId, migrationNames);
    console.log(`[db-upgrade-smoke] PASS: retained core data across ${migrationNames.length} migrations.`);
  } finally {
    if (ISOLATED_SCHEMA_PATTERN.test(schemaName)) {
      await adminClient.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
    await adminClient.end();
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runPopulatedUpgradeSmoke().catch((error) => {
    console.error(`[db-upgrade-smoke] FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
