/** @file Regression coverage for weight trend migration: weight trend v2 migration adds pace state and invalidates only pending older recommendations. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '0032_weight_trend_v2',
  'migration.sql'
);
const sourceRevisionMigrationPath = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '0033_weight_trend_source_revision',
  'migration.sql'
);

test('weight trend v2 migration adds pace state and invalidates only pending older recommendations', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /ADD COLUMN "trend_rate_grams_per_day" DOUBLE PRECISION/);
  assert.match(sql, /ADD COLUMN "trend_rate_std_grams_per_day" DOUBLE PRECISION/);
  assert.match(
    sql,
    /UPDATE "CalibrationRecommendation"[\s\S]*SET "status" = 'STALE'[\s\S]*WHERE "status" = 'PENDING'[\s\S]*"model_version" < 4/
  );
});

test('weight trend source revision migration preserves legacy rows as nullable stale snapshots', () => {
  const sql = fs.readFileSync(sourceRevisionMigrationPath, 'utf8');

  assert.match(sql, /ADD COLUMN "source_revision" VARCHAR\(64\)/);
  assert.doesNotMatch(sql, /NOT NULL|UPDATE|DELETE/);
});
