/** @file Regression coverage for account trust migration: account trust migration verifies existing users without inventing legal acceptance. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(__dirname, '../prisma/migrations/0035_account_verification_and_legal_consent/migration.sql');
const settingsTrustMigrationPath = path.join(
  __dirname, '../prisma/migrations/0038_settings_trust_center/migration.sql');

test('account trust migration verifies existing users without inventing legal acceptance', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /ADD COLUMN "email_verified_at"/);
  assert.match(sql, /UPDATE "User" SET "email_verified_at" = "created_at"/);
  assert.match(sql, /CREATE TABLE "LegalAcceptance"/);
  assert.doesNotMatch(sql, /INSERT INTO "LegalAcceptance"/);
});

test('account trust migration stores only purpose-bound token hashes', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /"purpose" "AccountTokenPurpose" NOT NULL/);
  assert.match(sql, /"token_hash" TEXT NOT NULL/);
  assert.doesNotMatch(sql, /"token" TEXT/);
  assert.match(sql, /ON DELETE CASCADE/);
});
test('settings trust migration preserves legacy reminder receipts during the per-type split', () => {
  const sql = fs.readFileSync(settingsTrustMigrationPath, 'utf8');

  for (const table of ['PushSubscription', 'NativePushSubscription']) {
    assert.match(sql, new RegExp(`UPDATE "${table}"[\\s\\S]*last_sent_weight_local_date" = "last_sent_local_date"`));
    assert.match(sql, new RegExp(`UPDATE "${table}"[\\s\\S]*last_sent_food_local_date" = "last_sent_local_date"`));
  }
});