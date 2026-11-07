/** @file Restore an active-source tracking snapshot into previously copied accounts without replacing identity, consent or live credentials. */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const TABLES = ['Goal', 'BodyMetric', 'MyFood', 'RecipeIngredient', 'FoodLog', 'DailyCaloriePlan',
  'FoodLogDay', 'FoodTrackingPause', 'CalibrationRecommendation', 'CaloriePlanRevision',
  'ActivityRecord', 'ActivityDaySummary', 'HealthConnectTombstone', 'BodyMetricTrend'];
const PROFILE_COLUMNS = ['id', 'email', 'created_at', 'onboarding_completed_at', 'weight_unit', 'height_unit',
  'timezone', 'language', 'reminder_log_weight_enabled', 'reminder_log_food_enabled',
  'reminder_log_weight_minute', 'reminder_log_food_minute', 'reminder_quiet_hours_start_minute',
  'reminder_quiet_hours_end_minute', 'haptics_enabled', 'date_of_birth', 'sex', 'height_mm',
  'activity_level', 'profile_image', 'profile_image_mime_type'];
const quote = value => `"${value.replaceAll('"', '""')}"`;
const profileSelect = PROFILE_COLUMNS.map(quote).join(', ');

/** Build a read-only MVCC export; rows stay JSON strings so PostgreSQL bigint/decimal precision is never lost in JavaScript. */
function trackingSnapshotSql(schema = 'public') {
  assert.match(schema, /^[a-z_][a-z0-9_]*$/);
  const tableEntries = TABLES.map(table => {
    const key = table === 'BodyMetricTrend' ? 'metric_id' : 'id';
    return `'${table}', jsonb_build_object(
      'columns', (SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='${schema}' AND table_name='${table}'),
      'rows', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY ${quote(key)}), '[]'::jsonb)::text FROM ${quote(schema)}.${quote(table)} t))`;
  });
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s'; SET LOCAL timezone = 'UTC';
SELECT jsonb_build_object('version', 1, 'capturedAt', transaction_timestamp(),
  'profiles', (SELECT jsonb_agg(to_jsonb(p) ORDER BY id)::text FROM (SELECT ${profileSelect} FROM ${quote(schema)}."User") p),
  'tables', jsonb_build_object(${tableEntries.join(',\n')}));
COMMIT;`;
}

/** Read canonical SQL JSON for exact round-trip validation without decoding large integers. */
async function canonicalRows(client, table) {
  const key = table === 'BodyMetricTrend' ? 'metric_id' : 'id';
  return (await client.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY ${quote(key)}), '[]'::jsonb)::text AS rows FROM public.${quote(table)} t`)).rows[0].rows;
}

/**
 * Copy history only into empty tracking tables for the exact original Firebase mappings.
 * A short target transaction excludes concurrent writes; the source remains writable.
 * Changed profiles or existing tracking data stop the operation. Only unconsumed,
 * unavailable daily-plan placeholders may be replaced. Dry runs roll back completely;
 * apply restores original onboarding timestamps and advances sequences without touching
 * credentials, consent, device checkpoints or the old installation. The caller supplies
 * an exclusively owned pg Client and independently verified project/database identities.
 */
async function copyTrackingSnapshot(client, snapshot, options) {
  assert.equal(snapshot?.version, 1, 'Unsupported tracking snapshot');
  assert.ok(Number.isFinite(Date.parse(snapshot.capturedAt)), 'Invalid snapshot timestamp');
  assert.deepEqual(Object.keys(snapshot.tables).sort(), [...TABLES].sort(), 'Unexpected snapshot tables');
  assert.equal(typeof snapshot.profiles, 'string', 'Missing source profiles');
  const profiles = JSON.parse(snapshot.profiles);
  assert.ok(Array.isArray(profiles) && profiles.length > 0, 'No source accounts');
  assert.equal(new Set(profiles.map(row => row.id)).size, profiles.length, 'Duplicate source identity');
  for (const row of profiles) assert.deepEqual(Object.keys(row).sort(), [...PROFILE_COLUMNS].sort(), 'Unexpected profile fields');
  assert.equal(options.mappings.length, profiles.length, 'Incomplete original identity manifest');
  const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '120s'; SET LOCAL timezone = 'UTC'");
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, options.database, 'Wrong target database');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`calibrate-history:${options.projectId}`]);
    await client.query(`LOCK TABLE public."User", public."FirebaseIdentity", ${TABLES.map(table => `public.${quote(table)}`).join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
    const currentProfiles = (await client.query(`SELECT to_jsonb(p) AS value FROM (SELECT ${profileSelect} FROM public."User") p ORDER BY id`)).rows.map(row => row.value);
    assert.equal(currentProfiles.length, profiles.length, 'Destination identity inventory changed');
    const identitiesBefore = (await client.query('SELECT to_jsonb(f)::text AS value FROM public."FirebaseIdentity" f ORDER BY user_id')).rows;
    const credentialsBefore = (await client.query('SELECT id, email, password_hash, credential_security_version, email_verified_at FROM public."User" ORDER BY id')).rows;
    for (const original of profiles) {
      const target = currentProfiles.find(row => row.id === original.id);
      assert.ok(target, 'Missing original account ID');
      for (const column of PROFILE_COLUMNS.filter(column => column !== 'onboarding_completed_at')) {
        assert.deepEqual(target[column], original[column], `Profile changed: ${column}`);
      }
      assert.ok(target.onboarding_completed_at === null || target.onboarding_completed_at === original.onboarding_completed_at, 'New production onboarding detected');
      const expected = options.mappings.find(row => row.userId === original.id);
      const mapped = identitiesBefore.map(row => JSON.parse(row.value)).find(row => row.user_id === original.id);
      assert.ok(expected && mapped && mapped.uid === expected.uid && mapped.project_id === options.projectId &&
        mapped.installation_id === options.installationId && mapped.source_id === options.sourceId && !mapped.deletion_pending_at,
      'Original immutable identity mapping differs');
    }
    const counts = {};
    let identical = true;
    for (const table of TABLES) {
      const source = snapshot.tables[table];
      const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table])).rows.map(row => row.column_name);
      assert.deepEqual(source.columns, columns, `Schema differs: ${table}`);
      assert.equal(typeof source.rows, 'string', 'Rows must retain SQL JSON precision');
      counts[table] = (await client.query('SELECT jsonb_array_length($1::jsonb) AS count', [source.rows])).rows[0].count;
      const current = await canonicalRows(client, table);
      if (current !== source.rows) identical = false;
    }
    const onboardingMatches = profiles.every(row => currentProfiles.find(target => target.id === row.id).onboarding_completed_at === row.onboarding_completed_at);
    if (identical && onboardingMatches) {
      await client.query('ROLLBACK');
      return { status: 'already-copied', digest, accounts: profiles.length, counts };
    }
    for (const table of TABLES) {
      const condition = table === 'DailyCaloriePlan' ? 'WHERE consumed_at IS NOT NULL OR target_kcal IS NOT NULL OR maintenance_kcal IS NOT NULL' : '';
      assert.equal((await client.query(`SELECT count(*)::int AS count FROM public.${quote(table)} ${condition}`)).rows[0].count, 0, `Existing production tracking data: ${table}`);
    }
    assert.ok(currentProfiles.every(row => row.onboarding_completed_at === null), 'Production onboarding already completed');
    await client.query('DELETE FROM public."DailyCaloriePlan" WHERE consumed_at IS NULL AND target_kcal IS NULL AND maintenance_kcal IS NULL');
    for (const table of TABLES) {
      const source = snapshot.tables[table];
      const columns = source.columns.map(quote).join(', ');
      await client.query(`INSERT INTO public.${quote(table)} (${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::public.${quote(table)}, $1::jsonb)`, [source.rows]);
      assert.equal(await canonicalRows(client, table), source.rows, `Round-trip data differs: ${table}`);
    }
    await client.query(`UPDATE public."User" u SET onboarding_completed_at=s.onboarding_completed_at FROM jsonb_populate_recordset(NULL::public."User", $1::jsonb) s WHERE u.id=s.id`, [snapshot.profiles]);
    assert.deepEqual((await client.query('SELECT to_jsonb(f)::text AS value FROM public."FirebaseIdentity" f ORDER BY user_id')).rows, identitiesBefore, 'Identity changed during history copy');
    assert.deepEqual((await client.query('SELECT id, email, password_hash, credential_security_version, email_verified_at FROM public."User" ORDER BY id')).rows, credentialsBefore, 'Credentials changed during history copy');
    if (options.apply) {
      for (const table of TABLES.filter(table => table !== 'BodyMetricTrend' && counts[table] > 0)) {
        // Sequence updates do not roll back; only advance, and only after all row checks pass.
        await client.query(`SELECT setval(pg_get_serial_sequence('public.${quote(table)}', 'id'), GREATEST((SELECT max(id) FROM public.${quote(table)}), (SELECT last_value FROM public.${quote(`${table}_id_seq`)})), true)`);
      }
    }
    await client.query(options.apply ? 'COMMIT' : 'ROLLBACK');
    return { status: options.apply ? 'copied' : 'dry-run', digest, accounts: profiles.length, counts, restoredOnboarding: profiles.filter(row => row.onboarding_completed_at).length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

module.exports = { TABLES, trackingSnapshotSql, copyTrackingSnapshot };
if (require.main === module) {
  if (process.argv.length === 3 && process.argv[2] === '--snapshot-sql') process.stdout.write(trackingSnapshotSql());
  else { console.error('Use --snapshot-sql for the read-only export; apply through the documented trusted operator adapter.'); process.exitCode = 1; }
}
