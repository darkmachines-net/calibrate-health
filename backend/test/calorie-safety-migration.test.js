/** @file Regression coverage for calorie safety migration: calorie safety migration preserves values and adds date-only sticky review fields. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(__dirname, '..', 'prisma', 'migrations', '0034_calorie_safety_policy', 'migration.sql');

test('calorie safety migration preserves values and adds date-only sticky review fields', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /ALTER COLUMN "date_of_birth" TYPE DATE USING "date_of_birth"::date/);
  assert.match(sql, /CREATE TYPE "CaloriePlanReviewStatus" AS ENUM \('CLEAR', 'REQUIRES_REVIEW'\)/);
  assert.doesNotMatch(sql, /CHECK\s*\(/i);
  assert.doesNotMatch(sql, /DELETE FROM|UPDATE "Goal"[\s\S]*daily_deficit\s*=/i);
});

test('calorie safety migration handles every signed integer deficit and lowercase IANA timezone', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.doesNotMatch(sql, /ABS\(daily_deficit\)/);
  assert.match(
    sql,
    /daily_deficit NOT IN \(-1000, -750, -500, -250, 0, 250, 500, 750, 1000\)/
  );
  assert.equal((sql.match(/LOWER\(tz\.name\) = LOWER\(u\."timezone"\)/g) ?? []).length, 2);
});

test('calorie safety migration marks every revision of a reviewed goal even for invalid timezones', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(
    sql,
    /UPDATE "CaloriePlanRevision" r[\s\S]*FROM "Goal" g[\s\S]*g\."id" = r\."source_goal_id"[\s\S]*g\."calorie_plan_review_status" = 'REQUIRES_REVIEW'/
  );
  const inheritance = sql.slice(sql.indexOf('UPDATE "CaloriePlanRevision" r'), sql.indexOf('-- Revisions inherit'));
  assert.doesNotMatch(inheritance, /pg_timezone_names|AT TIME ZONE/);
  assert.match(
    sql,
    /UPDATE "Goal" g[\s\S]*r\."source_goal_id" = g\."id"[\s\S]*r\."calorie_plan_review_reason" = 'PLAN_REVISION_UNSAFE'/
  );
  assert.match(sql, /UPDATE "CalibrationRecommendation" SET "status" = 'STALE' WHERE "status" = 'PENDING'/);
});
