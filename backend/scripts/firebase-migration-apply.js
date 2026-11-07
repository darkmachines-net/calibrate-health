#!/usr/bin/env node
/** @file Operator-only, dry-run-default Firebase import for a restored/frozen database, with durable receipts, immutable mappings and SQL preservation checks. */
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { planFirebaseMigration, runFirebaseMigration } = require('./lib/firebaseMigration');
const { withMigrationJournal } = require('./lib/migrationJournal');
const { revokeAccountCredentials } = require('../src/services/accountRevocation');

// These are the credential families deliberately invalidated at cutover; all other SQL rows must remain identical.
const CREDENTIAL_TABLES = new Set(['FirebaseIdentity', 'session_store', 'PushSubscription', 'MobileAuthSession', 'NativePushSubscription', 'WearPairingCredential', 'McpOAuthGrant', 'McpOAuthAuthorizationCode', 'AccountActionToken']);
const identifier = value => `"${value.replaceAll('"', '""')}"`;

/** Fingerprint every preserved table, including non-user-owned rows; never return raw tracking or credential data. */
async function preservationDigest(tx, tables) {
  const evidence = [];
  for (const table of tables.filter(table => !CREDENTIAL_TABLES.has(table))) {
    const expression = table === 'User' ? "to_jsonb(t) - 'credential_security_version'" : 'to_jsonb(t)';
    const rows = await tx.$queryRawUnsafe(`SELECT count(*)::text AS count, encode(sha256(convert_to(COALESCE(string_agg(row::text, E'\\n' ORDER BY row::text), ''), 'UTF8')), 'hex') AS digest FROM (SELECT ${expression} AS row FROM "public".${identifier(table)} t) snapshot`);
    evidence.push([table, rows[0].count, rows[0].digest]);
  }
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

/** Enumerate the complete provider inventory, including accounts without email; absence is never inferred from a partial page. */
async function destinationInventory(auth) {
  const rows = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    rows.push(...page.users.map(user => ({ uid: user.uid, email: user.email })));
    pageToken = page.pageToken;
  } while (pageToken);
  return rows;
}

/**
 * Lock a restored public schema, plan/import unchanged bcrypt credentials and atomically install mappings.
 * Caller must exclude Firebase identity writers and keep this source immutable before apply.
 * Full-data cutovers freeze the live source; account-only copies supply a fixed snapshot instead.
 * Uncertain imports remain held by the journal; errors roll SQL back and never retry provider upserts blindly.
 */
async function migrateFrozenDatabase(database, auth, scope, { planPath, journalPath, apply = false }) {
  return database.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))::text', `calibrate-firebase:${scope.projectId}`);
    const tables = (await tx.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).map(row => row.tablename);
    if (!tables.includes('User') || !tables.includes('FirebaseIdentity')) throw new Error('Expected migrated public schema');
    await tx.$executeRawUnsafe(`LOCK TABLE ${tables.map(table => `"public".${identifier(table)}`).join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
    const preserved = await preservationDigest(tx, tables);
    const readSource = async () => (await tx.user.findMany({ orderBy: { id: 'asc' }, include: { firebase_identity: true } })).map(user => ({
      id: user.id, email: user.email, passwordHash: user.password_hash, emailVerified: Boolean(user.email_verified_at),
      preservationDigest: preserved, providerLinked: Boolean(user.firebase_identity)
    }));
    const source = await readSource();
    let plan;
    if (fs.existsSync(planPath)) {
      plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
      if (JSON.stringify(plan.scope) !== JSON.stringify(scope)) throw new Error('Migration scope differs');
      const current = planFirebaseMigration(scope, source, []);
      if (JSON.stringify(current.records.map(row => row.sourceDigest)) !== JSON.stringify(plan.records.map(row => row.sourceDigest))) throw new Error('Migration source changed');
    } else {
      plan = planFirebaseMigration(scope, source, await destinationInventory(auth));
      fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    if (!apply) return { mode: 'dry-run', ...plan.summary, digest: plan.digest };
    const receipt = await withMigrationJournal(journalPath, plan, (checkpoint, saveCheckpoint) => runFirebaseMigration(plan, {
      apply: true, checkpoint, saveCheckpoint, readSource,
      destination: {
        projectId: scope.projectId,
        /** Recheck both namespaces immediately before each import; external identity freeze remains mandatory. */
        findCollisions: async records => (await auth.getUsers(records.flatMap(row => [{ uid: row.uid }, { email: row.email }]))).users.length > 0,
        /** Preserve the full encoded bcrypt bytes; Firebase receives no health data, permissions or legal claims. */
        importUsers: (records, options) => auth.importUsers(records, options)
      },
      // getUsers accepts 100 identifiers; each account is inspected by both UID and email.
      batchSize: 50
    }));
    if (receipt.states.some(state => state !== 'imported')) throw new Error('Incomplete import receipt');
    for (const record of plan.records) {
      const account = source[record.ordinal];
      const remote = await auth.getUser(record.uid);
      if (remote.uid !== record.uid || remote.email?.toLowerCase() !== account.email.trim().toLowerCase() || remote.emailVerified !== account.emailVerified || remote.disabled) throw new Error('Imported identity differs');
      await tx.firebaseIdentity.create({ data: {
        user_id: record.userId, installation_id: scope.installationId, source_id: scope.sourceId, project_id: scope.projectId, uid: record.uid,
        security_stamp: JSON.stringify([remote.tokensValidAfterTime ?? null, remote.email.toLowerCase(), remote.disabled, remote.emailVerified])
      } });
      await tx.user.update({ where: { id: record.userId }, data: { credential_security_version: { increment: 1 } } });
      await revokeAccountCredentials(tx, record.userId);
    }
    if (await preservationDigest(tx, tables) !== preserved) throw new Error('SQL preservation check failed');
    return { mode: 'applied', accounts: source.length, digest: plan.digest, preserved: true };
  }, { isolationLevel: 'RepeatableRead', timeout: 30 * 60 * 1000, maxWait: 10000 });
}

/** Require explicit project/database identity and an operator-owned maintenance window; never infer a live cutover from defaults. */
async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node -r ts-node/register scripts/firebase-migration-apply.js --project=ID --database=NAME --installation=ID --source=ID --plan=PATH --journal=PATH [--apply --writers-frozen]');
    console.log('Use only a backed-up, restored public schema with all SQL and Firebase writers frozen. Dry run is the default.');
    return;
  }
  const options = {};
  for (const arg of args) {
    const match = /^--(project|database|installation|source|plan|journal)=(.+)$/.exec(arg);
    if (match && !Object.hasOwn(options, match[1])) options[match[1]] = match[2];
    else if (['--apply', '--writers-frozen'].includes(arg) && !options[arg]) options[arg] = true;
    else throw new Error('Invalid argument');
  }
  if (['project', 'database', 'installation', 'source', 'plan', 'journal'].some(key => !options[key]) || options.project !== process.env.FIREBASE_PROJECT_ID || (options['--apply'] && !options['--writers-frozen'])) throw new Error('Explicit identity and freeze required');
  const { resolveDatabaseConnection } = require('../src/config/databaseUtils');
  if (resolveDatabaseConnection().schema !== 'public') throw new Error('Public schema required');
  const database = require('../src/config/database');
  const { applicationDefault, initializeApp, deleteApp } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const app = initializeApp({ projectId: options.project, credential: applicationDefault() }, 'calibrate-migration');
  try {
    const rows = await database.default.$queryRawUnsafe('SELECT current_database() AS name');
    if (rows[0].name !== options.database) throw new Error('Database identity differs');
    const result = await migrateFrozenDatabase(database.default, getAuth(app), { installationId: options.installation, sourceId: options.source, projectId: options.project }, {
      planPath: options.plan, journalPath: options.journal, apply: Boolean(options['--apply'])
    });
    console.log(JSON.stringify(result));
    if (result.held) process.exitCode = 2;
  } finally {
    await database.disconnectDatabase();
    await deleteApp(app);
  }
}

module.exports = { migrateFrozenDatabase };
if (require.main === module) main(process.argv.slice(2)).catch(() => {
  console.error('Migration stopped. Retain the plan/journal and reconcile provider outcomes before retrying; SQL changes were not confirmed. No credentials or provider responses were logged.');
  process.exitCode = 1;
});
