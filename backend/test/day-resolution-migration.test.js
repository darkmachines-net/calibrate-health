/** @file Regression coverage for day resolution migration: day resolution migration preserves legacy completion and enforces one active pause. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '0030_day_resolution_and_tracking_pauses',
  'migration.sql'
);

test('day resolution migration preserves legacy completion and enforces one active pause', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');

  assert.match(
    migration,
    /CREATE TYPE "FoodLogDayStatus" AS ENUM \('OPEN', 'COMPLETE', 'INCOMPLETE', 'PAUSED'\)/
  );
  assert.match(
    migration,
    /WHEN "is_complete" THEN 'COMPLETE'::"FoodLogDayStatus"[\s\S]*ELSE 'OPEN'::"FoodLogDayStatus"/
  );
  assert.match(migration, /ALTER TABLE "FoodLogDay" DROP COLUMN "is_complete"/);
  assert.match(migration, /CREATE TABLE "FoodTrackingPause"/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "FoodTrackingPause_one_active_per_user"[\s\S]*WHERE "resumed_on" IS NULL/
  );
  assert.match(migration, /ON DELETE CASCADE ON UPDATE CASCADE/);
});
