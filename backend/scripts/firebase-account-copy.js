#!/usr/bin/env node
/** @file Copy an immutable account-only snapshot into an empty Firebase-backed installation without freezing or modifying its live source. */
const fs = require('node:fs');
const { migrateFrozenDatabase } = require('./firebase-migration-apply');

// Explicitly exclude sessions, tokens, security generations, onboarding completion and all tracking tables.
const USER_COLUMNS = ['id', 'email', 'password_hash', 'created_at', 'email_verified_at',
  'weight_unit', 'height_unit', 'timezone', 'language', 'reminder_log_weight_enabled',
  'reminder_log_food_enabled', 'reminder_log_weight_minute', 'reminder_log_food_minute',
  'reminder_quiet_hours_start_minute', 'reminder_quiet_hours_end_minute', 'haptics_enabled',
  'date_of_birth', 'sex', 'height_mm', 'activity_level', 'profile_image_mime_type'];
const CONSENT_COLUMNS = ['id', 'user_id', 'terms_version', 'privacy_version', 'accepted_at'];
const DATE_COLUMNS = new Set(['created_at', 'email_verified_at', 'date_of_birth', 'accepted_at']);

/** Read one consistent MVCC snapshot; ACCESS SHARE reads allow ordinary source writes to continue. */
const ACCOUNT_SNAPSHOT_SQL = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL timezone = 'UTC';
SELECT json_build_object('version', 1, 'capturedAt', transaction_timestamp(),
  'users', COALESCE((SELECT json_agg(row ORDER BY id) FROM
    (SELECT ${USER_COLUMNS.map(column => `"${column}"`).join(', ')}, encode(profile_image, 'hex') AS profile_image_hex FROM "User") row), '[]'::json),
  'legalAcceptances', COALESCE((SELECT json_agg(row ORDER BY id) FROM
    (SELECT ${CONSENT_COLUMNS.map(column => `"${column}"`).join(', ')} FROM "LegalAcceptance") row), '[]'::json));
COMMIT;`;

/** Reject unexpected snapshot fields instead of allowing an inventory to import additional privileges or data. */
function checkedRow(row, columns, extra = []) {
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      Object.keys(row).some(key => !columns.includes(key) && !extra.includes(key)) ||
      columns.some(key => !Object.hasOwn(row, key))) throw new Error('Invalid account snapshot row');
  return Object.fromEntries(columns.map(key => {
    if (!DATE_COLUMNS.has(key) || row[key] === null) return [key, row[key]];
    // PostgreSQL timestamp-without-zone values in this application are UTC.
    const value = row[key];
    if (typeof value !== 'string') throw new Error('Invalid snapshot date');
    const utc = value.length === 10 ? `${value}T00:00:00Z` : `${value}Z`;
    const date = new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : utc);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid snapshot date');
    return [key, date];
  }));
}

/**
 * Seed only accounts/recorded consent, then import credentials and mappings in one target SQL transaction.
 * The snapshot is a fixed point-in-time copy: later source changes are intentionally not synchronized.
 * Target identity writers must be excluded; source writers can remain active. Existing target accounts
 * are never merged or overwritten. Dry runs roll SQL back; confirmed provider receipts support retry
 * after SQL failure with the exact same protected snapshot, plan and journal.
 */
async function copyAccountSnapshot(database, auth, scope, snapshot, options) {
  if (snapshot?.version !== 1 || !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
      !Array.isArray(snapshot.users) || !snapshot.users.length || !Array.isArray(snapshot.legalAcceptances) ||
      Object.keys(snapshot).some(key => !['version', 'capturedAt', 'users', 'legalAcceptances'].includes(key))) {
    throw new Error('Invalid account snapshot');
  }
  const users = snapshot.users.map(row => {
    const data = checkedRow(row, USER_COLUMNS, ['profile_image_hex']);
    if (row.profile_image_hex !== null && (typeof row.profile_image_hex !== 'string' || !/^(?:[a-f0-9]{2})*$/.test(row.profile_image_hex))) throw new Error('Invalid profile image');
    return { ...data, profile_image: row.profile_image_hex === null ? null : Buffer.from(row.profile_image_hex, 'hex'), onboarding_completed_at: null };
  });
  const consent = snapshot.legalAcceptances.map(row => checkedRow(row, CONSENT_COLUMNS));
  const dryRun = Symbol('account-copy-dry-run');
  try {
    return await database.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))::text', `calibrate-firebase:${scope.projectId}`);
      await tx.$executeRawUnsafe('LOCK TABLE "User", "LegalAcceptance", "FirebaseIdentity" IN SHARE ROW EXCLUSIVE MODE');
      if (await tx.user.count() || await tx.firebaseIdentity.count() || await tx.legalAcceptance.count()) throw new Error('Account copy requires an empty destination');
      await tx.user.createMany({ data: users });
      if (consent.length) await tx.legalAcceptance.createMany({ data: consent });
      // Reuse the importer against this transaction's immutable target snapshot, never the live source.
      const result = await migrateFrozenDatabase({ $transaction: work => work(tx) }, auth, scope, options);
      if (!options.apply) throw { marker: dryRun, result };
      for (const table of consent.length ? ['User', 'LegalAcceptance'] : ['User']) {
        // Sequence changes are not transactional: advance only, including after a prior rolled-back attempt.
        await tx.$queryRawUnsafe(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), GREATEST((SELECT max(id) FROM "${table}"), (SELECT last_value FROM "${table}_id_seq")), true)::text`);
      }
      return { ...result, mode: 'account-copy', consentRecords: consent.length, onboardingRequired: users.length };
    }, { isolationLevel: 'RepeatableRead', timeout: 30 * 60 * 1000, maxWait: 10000 });
  } catch (error) {
    if (error?.marker === dryRun) return error.result;
    throw error;
  }
}

/** Run the explicit account-copy command; credentials stay in protected input storage and are never logged. */
async function main(args) {
  if (args.length === 1 && args[0] === '--snapshot-sql') { process.stdout.write(ACCOUNT_SNAPSHOT_SQL); return; }
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node -r ts-node/register scripts/firebase-account-copy.js --project=ID --database=NAME --installation=ID --source=ID --snapshot=PRIVATE_PATH --plan=PRIVATE_PATH --journal=PRIVATE_PATH [--apply --destination-exclusive]');
    console.log('Use --snapshot-sql to obtain the read-only source query. No source freeze is required. Target must be empty; dry run is the default.');
    return;
  }
  const options = {};
  for (const arg of args) {
    const match = /^--(project|database|installation|source|snapshot|plan|journal)=(.+)$/.exec(arg);
    if (match && !Object.hasOwn(options, match[1])) options[match[1]] = match[2];
    else if (['--apply', '--destination-exclusive'].includes(arg) && !options[arg]) options[arg] = true;
    else throw new Error('Invalid argument');
  }
  if (['project', 'database', 'installation', 'source', 'snapshot', 'plan', 'journal'].some(key => !options[key]) ||
      options.project !== process.env.FIREBASE_PROJECT_ID || process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      (options['--apply'] && !options['--destination-exclusive'])) throw new Error('Explicit production target identity and exclusive destination required');
  const { resolveDatabaseConnection } = require('../src/config/databaseUtils');
  if (resolveDatabaseConnection().schema !== 'public') throw new Error('Public schema required');
  const snapshot = JSON.parse(fs.readFileSync(options.snapshot, 'utf8'));
  const database = require('../src/config/database');
  const { applicationDefault, initializeApp, deleteApp } = require('firebase-admin/app');
  const app = initializeApp({ projectId: options.project, credential: applicationDefault() }, 'calibrate-account-copy');
  try {
    const rows = await database.default.$queryRawUnsafe('SELECT current_database() AS name');
    if (rows[0].name !== options.database) throw new Error('Database identity differs');
    const result = await copyAccountSnapshot(database.default, require('firebase-admin/auth').getAuth(app), {
      installationId: options.installation, sourceId: options.source, projectId: options.project
    }, snapshot, { planPath: options.plan, journalPath: options.journal, apply: Boolean(options['--apply']) });
    console.log(JSON.stringify(result));
    if (result.held) process.exitCode = 2;
  } finally {
    await database.disconnectDatabase();
    await deleteApp(app);
  }
}

module.exports = { ACCOUNT_SNAPSHOT_SQL, copyAccountSnapshot };
if (require.main === module) main(process.argv.slice(2)).catch(() => {
  console.error('Account copy stopped. Retain the protected snapshot, plan and journal for reconciliation. No credentials or provider responses were logged.');
  process.exitCode = 1;
});
