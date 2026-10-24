/** @file Regression coverage for postgres populated upgrade smoke: migrationOrdinal accepts tracked ordinal names and rejects malformed names. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  createLegacyMigrationTree,
  databaseUrlForSchema,
  discoverMigrationNames,
  migrationOrdinal,
} from './postgres-populated-upgrade-smoke.mjs';

test('migrationOrdinal accepts tracked ordinal names and rejects malformed names', () => {
  assert.equal(migrationOrdinal('0020_goal_active_lookup_index'), 20);
  assert.throws(() => migrationOrdinal('native_mobile_client'), /four-digit ordinal/);
});

test('databaseUrlForSchema preserves connection options while replacing schema', () => {
  const result = new URL(databaseUrlForSchema(
    'postgresql://user:pass@localhost:5432/calibrate?schema=tenant&sslmode=disable',
    'calibrate_upgrade_smoke_123_abcdef'
  ));
  assert.equal(result.searchParams.get('schema'), 'calibrate_upgrade_smoke_123_abcdef');
  assert.equal(result.searchParams.get('sslmode'), 'disable');
  assert.throws(
    () => databaseUrlForSchema('postgresql://localhost/calibrate', 'public'),
    /Refusing unsafe/
  );
});

test('legacy migration tree includes every migration through 0020 and no native migrations', () => {
  const migrationNames = discoverMigrationNames();
  const tree = createLegacyMigrationTree(migrationNames);
  try {
    assert(tree.legacyNames.length > 0);
    assert(tree.legacyNames.every((name) => migrationOrdinal(name) <= 20));
    assert(tree.legacyNames.includes('0020_goal_active_lookup_index'));
    assert(!tree.legacyNames.includes('0021_mobile_native_client'));
    assert(fs.existsSync(tree.schemaPath));
  } finally {
    fs.rmSync(tree.temporaryRoot, { recursive: true, force: true });
  }
});
