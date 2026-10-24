/** @file Regression coverage for activity utils: activity utils parse source identity and derive local day in the account timezone. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseActivityRange,
  parseHealthConnectSyncBody
} = require('../src/routes/activityUtils');

function baseSync(overrides = {}) {
  return {
    sync_mode: 'incremental',
    record_type: 'STEPS',
    previous_changes_token: null,
    next_changes_token: 'next-token',
    upserts: [{
      record_id: 'steps-1',
      data_origin: 'com.sec.android.app.shealth',
      source_updated_at: '2026-03-08T09:45:00.000Z',
      start_time: '2026-03-08T09:30:00.000Z',
      end_time: '2026-03-08T09:45:00.000Z',
      start_zone_offset_seconds: -28800,
      end_zone_offset_seconds: -25200,
      count: 800
    }],
    deleted_record_ids: [],
    day_summaries: [],
    ...overrides
  };
}

test('activity utils parse source identity and derive local day in the account timezone', () => {
  const parsed = parseHealthConnectSyncBody(baseSync(), 'America/Los_Angeles');

  assert.equal(parsed.recordType, 'STEPS');
  assert.equal(parsed.upserts[0].externalId, 'steps-1');
  assert.equal(parsed.upserts[0].stepCount, 800);
  assert.equal(parsed.upserts[0].localDate.toISOString(), '2026-03-08T00:00:00.000Z');
});

test('activity utils enforce record-type-specific values and interval ordering', () => {
  assert.throws(
    () => parseHealthConnectSyncBody(baseSync({
      upserts: [{
        record_id: 'weight-1',
        data_origin: 'com.google.android.apps.healthdata',
        source_updated_at: '2026-07-11T12:00:00Z',
        start_time: '2026-07-11T12:00:00Z',
        count: 100
      }],
      record_type: 'WEIGHT'
    }), 'UTC'),
    /unsupported field count/
  );

  assert.throws(
    () => parseHealthConnectSyncBody(baseSync({
      upserts: [{ ...baseSync().upserts[0], end_time: '2026-03-08T09:00:00Z' }]
    }), 'UTC'),
    /end_time must be after start_time/
  );
});

test('activity utils enforce exact Health Connect weight policy bounds', () => {
  const weightSync = (weight_grams) => baseSync({
    record_type: 'WEIGHT',
    upserts: [{
      record_id: 'weight-1', data_origin: 'com.google.android.apps.healthdata',
      source_updated_at: '2026-07-11T12:00:00Z', start_time: '2026-07-11T12:00:00Z', weight_grams
    }]
  });
  assert.equal(parseHealthConnectSyncBody(weightSync(25_000), 'UTC').upserts[0].weightGrams, 25_000);
  assert.equal(parseHealthConnectSyncBody(weightSync(400_000), 'UTC').upserts[0].weightGrams, 400_000);
  assert.throws(() => parseHealthConnectSyncBody(weightSync(24_999), 'UTC'), /Invalid weight_grams/);
  assert.throws(() => parseHealthConnectSyncBody(weightSync(400_001), 'UTC'), /Invalid weight_grams/);
});
test('activity utils accept BigInt-safe client versions and nullable aggregate totals', () => {
  const parsed = parseHealthConnectSyncBody(baseSync({
    upserts: [{ ...baseSync().upserts[0], client_record_version: '9007199254740993' }],
    day_summaries: [{
      local_date: '2026-07-11',
      steps: 12000,
      active_calories_kcal: null,
      total_calories_kcal: null,
      exercise_minutes: 45,
      observed_at: '2026-07-12T07:00:00Z'
    }]
  }), 'UTC');

  assert.equal(parsed.upserts[0].clientRecordVersion, 9007199254740993n);
  assert.equal(parsed.daySummaries[0].steps, 12000);
  assert.equal(parsed.daySummaries[0].activeCaloriesKcal, null);
});

test('activity utils reject ambiguous pages and stale-token reset shapes', () => {
  assert.throws(
    () => parseHealthConnectSyncBody(baseSync({ deleted_record_ids: ['steps-1'] }), 'UTC'),
    /cannot be upserted and deleted/
  );
  assert.throws(
    () => parseHealthConnectSyncBody(baseSync({ sync_mode: 'reset', previous_changes_token: 'old' }), 'UTC'),
    /Reset sync must use a null previous_changes_token/
  );
  assert.throws(
    () => parseHealthConnectSyncBody(baseSync({
      upserts: [{ ...baseSync().upserts[0], source_updated_at: '2026-07-11T12:00:00' }]
    }), 'UTC'),
    /Invalid source_updated_at/
  );
});

test('activity utils require explicit sync mode and validate reset replacement windows', () => {
  const missingMode = baseSync();
  delete missingMode.sync_mode;
  assert.throws(() => parseHealthConnectSyncBody(missingMode, 'UTC'), /Invalid sync_mode/);
  assert.throws(
    () => parseHealthConnectSyncBody(baseSync({
      replace_window: { start_date: '2026-07-01', end_date: '2026-07-11' }
    }), 'UTC'),
    /allowed only for reset/
  );

  const parsed = parseHealthConnectSyncBody(baseSync({
    sync_mode: 'reset',
    previous_changes_token: null,
    replace_window: { start_date: '2026-07-01', end_date: '2026-07-11' }
  }), 'UTC');
  assert.equal(parsed.replaceWindow.start.toISOString(), '2026-07-01T00:00:00.000Z');
  assert.equal(parsed.replaceWindow.end.toISOString(), '2026-07-11T00:00:00.000Z');
});

test('activity range uses inclusive date-only math across DST boundaries', () => {
  const range = parseActivityRange({ start: '2026-03-07', end: '2026-03-09' }, 'America/Los_Angeles');
  assert.deepEqual(range.dateKeys, ['2026-03-07', '2026-03-08', '2026-03-09']);

  assert.throws(
    () => parseActivityRange({ start: '2026-07-11' }, 'UTC'),
    /provided together/
  );
});
