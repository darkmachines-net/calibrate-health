# Identity migration tooling

[firebaseMigration.ts](firebaseMigration.ts) and [migrationJournal.ts](migrationJournal.ts)
provide a dry-run-first, injected migration engine and a single-host durable journal.
They do not activate Firebase or acquire accounts themselves. The explicit
[operator adapter](../firebase-migration-apply.js) supplies live SQL/provider access
under the freeze contract below; the [account-copy adapter](../firebase-account-copy.js)
instead consumes an immutable snapshot without freezing its live source. Runtime
HTTP endpoints never invoke either adapter.
[credentialProvider.ts](credentialProvider.ts) is the compatibility export for the
runtime verifier in `src/services/credentialVerification.ts`.

From `backend/`, run `node -r ts-node/register scripts/firebase-migration-plan.js --help`
or pass a protected operator inventory JSON. Exit 0 means offline checks passed,
2 means accounts are held, and 1 means invalid input. None establishes cutover readiness.

Input shape (placeholders below are intentionally not a valid inventory):

```json
{
  "scope": {
    "installationId": "stable-installation-id",
    "sourceId": "stable-source-database-id",
    "projectId": "installation-owned-project-id"
  },
  "accounts": [{
    "id": 123,
    "email": "synthetic@example.invalid",
    "passwordHash": "<complete encoded bcrypt hash>",
    "emailVerified": false,
    "preservationDigest": "<64 lowercase hex characters>",
    "providerLinked": false,
    "disabled": false
  }],
  "destination": [{ "uid": "existing-uid", "email": "other@example.invalid" }]
}
```

Use separately authorized, installation-specific acquisition for real inventories.
The offline planner performs no live acquisition. Its destination input must enumerate
all identities, including identities without email; an empty list means the
operator supplied an empty snapshot, not that Firebase was inspected. Inventories
contain credentials and must remain in protected operator storage, never Git,
PR attachments, or ordinary logs. This task's tests use synthetic data only.

`preservationDigest` must bind the canonical ownership/access snapshot collected
by the source adapter: owned-row identities and content, verification
timestamp/history, onboarding state, and genuine legal acceptances. The planner
only checks its format and detects changes; it cannot establish completeness or
preservation from a digest supplied by a caller. The operator adapter fingerprints
all preserved SQL tables and checks the same digest before committing mappings.

Scope IDs are stable non-secret names, not connection strings. Deterministic
UIDs include the installation, source, destination project and integer User.id.
Changing any scope yields different UIDs and requires a new reviewed manifest.
Keep environments in separate Firebase projects. Never match or merge accounts
by email. Case/normalization collisions hold **every** affected source account.
Destination UID or email collisions, existing links, disabled accounts, invalid
IDs/state and unsupported hashes also hold the affected rows. Resolve them
explicitly before preparing a new plan; do not select the first matching row.

Plans retain original input ordinals, valid application IDs, deterministic UIDs,
source fingerprints, hold categories and aggregate counts. They contain no
emails, hashes, tokens or health records. The source fingerprint includes the
encoded salted password hash but does not expose it. Treat the plan as private
operational metadata. Its digest detects accidental changes; it is not a
signature or authorization boundary.

## Import engine contract

`backend/scripts/lib/firebaseMigration.ts` supplies a testable, dry-run-default
engine used by the operator adapter. The
injected source, destination and checkpoint store are trusted operator components,
not an HTTP API. Tests substitute a synthetic destination; they do not claim
Firebase behavior or database durability.

- Pin the exact plan and source order. Validate source/destination identity using
  independently trusted connection metadata, not just names supplied in JSON.
- Hold an exclusive source auth-write freeze and destination identity-write freeze
  across inspection, import, reconciliation and final authorization. Serialize
  importer processes too. The engine itself does not acquire these freezes.
  A collision precheck alone has a race: Firebase import has no create-only
  precondition and can overwrite a UID or duplicate an email.
- `withMigrationJournal` supplies a single-host append-only checkpoint store.
  It flushes each record with fsync before resolving `saveCheckpoint`, binds the
  manifest, and holds an exclusive lock file. It refuses a second importer,
  torn records, stale locks and state rewinds. A process crash retains the lock;
  never remove it automatically. Operator reconciliation must first establish
  that its owner and any outstanding remote requests are quiescent. This lock
  does not block database/Firebase writers or coordinate multiple hosts. Protect
  the directory with platform ACLs; POSIX mode 0600 alone does not establish
  Windows ACLs. Test and approve storage durability and backup on the intended
  operator filesystem before a real import; synthetic process-restart tests do
  not certify recovery after host power loss.
- Batches default to 100 and cannot exceed 1,000. Send only UID, normalized email,
  original verification boolean and UTF-8 bytes of the complete encoded bcrypt
  hash, with `{ hash: { algorithm: 'BCRYPT' } }`. No separate salt/cost options,
  health data, application permissions or legal claims are sent.
- Before each batch, recheck source fingerprints and destination UID/email
  absence. Persist `in_flight` before import. Persist indexed outcomes after a
  validated response. Resume skips `imported` records, protecting passwords
  changed at the destination after import. It continues untouched `pending` rows.
- Any timeout, lost response, crash with `in_flight`, malformed result, persistence
  failure or partial result stops the run. `rejected` and `in_flight` records are
  never automatically retried. Do not reset their states to `pending` manually.
  Recovery tooling must first quiesce outstanding writes, obtain authoritative
  per-record evidence and prove a record was never imported before retrying it.
  Mere absence immediately after timeout is insufficient. Recovery tooling remains
  a later stage; keep the original checkpoint and receipts intact.
- A successful import is not a SQL identity mapping or credential cutover. A
  final transaction must install a uniquely constrained immutable project/UID
  mapping against the unchanged User.id. Retain the local hash under the agreed
  rollback policy without permitting fallback after authority changes.

The engine refuses a plan with any held account. This makes resolution explicit;
an operator must not silently omit difficult accounts to produce a green plan.

## Frozen database operator adapter

[firebase-migration-apply.js](../firebase-migration-apply.js) runs on host Node with
`ts-node/register`, ADC and the usual `DATABASE_URL`/`DB_*` connection settings.
It requires the `public` schema, an explicit database name matching the live
connection, and a project argument matching `FIREBASE_PROJECT_ID`. Independently
verify the connection target/Cloud SQL proxy project before supplying those names.
Create a protected operator directory for plan/journal files; it must have private
Windows ACLs or equivalent permissions. Neither file belongs in Git or an image.

From `backend/`, use this dry run against the restored target:

```text
node -r ts-node/register scripts/firebase-migration-apply.js --project=calibrate-health --database=calibrate --installation=calibrate-health --source=private-host --plan=PRIVATE_PLAN_PATH --journal=PRIVATE_JOURNAL_PATH
```

The adapter takes an advisory transaction lock and locks all public tables against
writes, inventories every Firebase identity, and fingerprints all preserved SQL
rows in deterministic order. It retains IDs, password hashes, email verification
dates, onboarding, tracking data and genuine consent. Its two intentional changes
are immutable provider mappings and credential revocation/security-generation advance.
The new plan contains no emails, password hashes or health rows. Exit 2 means held
accounts; stop and resolve them without omitting accounts.

Before adding `--apply --writers-frozen`, freeze writes on the original deployment
and all Firebase identity writers, including the new API, administrative scripts and
console operators. Keep client signup/deletion disabled. The command cannot enforce
those external freezes; its SQL locks and single-host journal are not a distributed
maintenance barrier. Apply only after an encrypted backup and verified restore into
an isolated target, using the exact reviewed plan and source scope.

Each batch persists its receipt before the next operation. Once all imports are
confirmed, one SQL transaction verifies provider identity/verification state, installs
the immutable mappings, revokes existing credentials, and checks the complete
preservation digest again. A SQL failure leaves confirmed provider receipts available
for a resume that does not reimport or overwrite destination passwords. A completed
mapping makes the old plan stale; rerunning it fails closed. Ambiguous provider outcomes
still require the manual reconciliation described above.

`npm run gcp:test:authentication` rehearses this adapter on an owned empty database
and Auth Emulator, including source drift and failure after provider success but
before SQL commit. Real BCRYPT compatibility is tested separately in the cloud smoke.
After final migration, verify account/data counts and authenticated access, then switch
the database/public origin and release destination together. Never resume a local
password authority against the migrated accounts or discard new tracking writes.

## Account-only copy from an active source

[firebase-account-copy.js](../firebase-account-copy.js) creates matching accounts in
an empty destination while the original deployment remains writable. This is an
independent point-in-time copy, not a tracking-data cutover or ongoing synchronization.
Subsequent password, email, profile and deletion changes in either installation do
not propagate to the other. Its source is the immutable exported snapshot, so the
live source does not need the freeze required by the full-database adapter.

From `backend/`, `node -r ts-node/register scripts/firebase-account-copy.js --snapshot-sql`
prints the read-only, repeatable-read source query. Run it through a trusted source
connection using `psql -X -qAt -v ON_ERROR_STOP=1`; capture its JSON directly into a
private operator file without printing it. This query allows ordinary source writes
and reads only account/profile fields and recorded legal acceptances. The snapshot
contains password hashes and personal information: protect it with private filesystem
ACLs, never commit or attach it, and remove it after confirmed completion.

```text
node -r ts-node/register scripts/firebase-account-copy.js --project=calibrate-health --database=calibrate --installation=calibrate-health --source=private-host-account-copy --snapshot=PRIVATE_SNAPSHOT_PATH --plan=PRIVATE_PLAN_PATH --journal=PRIVATE_JOURNAL_PATH
```

The default dry run rolls all SQL inserts back. Add `--apply --destination-exclusive`
after inspecting eligibility and excluding other **destination** identity writers.
For initial provisioning this can be a private API with client signup/deletion disabled,
an empty Firebase inventory, and no competing administrative operations. No source
maintenance window is required. The CLI rejects emulators and verifies the explicit
project/database identity; independently verify its Cloud SQL connection as usual.

The adapter preserves account IDs, original bcrypt hashes, verification dates,
profile/preferences and actual recorded consent. It resets onboarding completion
because goals and current weight are deliberately absent. It never copies food,
weight, goal or activity history, live sessions, recovery tokens or device credentials.
No new legal acceptance is invented. Only credential fields go to Firebase; the
profile and consent remain in Calibrate's SQL database.

Account rows and immutable provider mappings commit together. Existing destination
accounts are rejected, never merged by email or overwritten. The same durable journal
and collision checks protect Firebase imports. After a SQL failure, retry with the
exact same snapshot/plan/journal to reuse confirmed imports without resetting their
passwords. Uncertain provider outcomes still require reconciliation. A completed copy
cannot be repeated against the now-populated target. `gcp:test:authentication` rehearses
active-source changes, dry-run rollback, mapping failure/retry, preservation, excluded
history and sequence advancement.

## Completing an account-only copy with tracking history

[tracking-history-copy.js](../tracking-history-copy.js) exports a read-only,
repeatable-read snapshot query (`node scripts/tracking-history-copy.js --snapshot-sql`)
and `copyTrackingSnapshot(pgClient, snapshot, options)` for a trusted operator.
Capture the SQL output directly into a file with private filesystem ACLs. It contains
health data and profiles, but no password hashes or session credentials. Its table
JSON remains encoded as strings to preserve PostgreSQL bigint/decimal precision.

Verify the source connection and target Cloud SQL project/database independently,
take a target backup, and supply the original account import manifest's `userId`/`uid`
pairs plus its installation/source/project IDs. The default dry run rolls back all
SQL changes. `apply: true` copies food/weight/goal/activity history, reusable foods,
recipes, target/day state and trends, then restores the source's
original onboarding completion timestamps. Exact row round trips are checked in
the same transaction, and sequences only advance after successful validation.

The source stays writable. A short target transaction locks the affected tables;
different identity mappings, changed profile fields, completed target onboarding,
schema differences or existing target tracking data stop the copy. Only unconsumed
daily-plan placeholders with no computed target/maintenance values may be replaced.
Existing Firebase authority, passwords, sessions and recorded consent remain intact.
The production notification feed remains intact. Old reminders, device sync checkpoints,
mutation replay receipts, change feeds and credentials
are not portable and are excluded. This is a point-in-time copy, not ongoing sync.

Retain the aggregate receipt and snapshot digest, verify authenticated access, then
remove the private raw export. An exact completed copy is recognized on retry;
changed production data is never silently overwritten. `gcp:test:authentication`
rehearses source writes, dry-run rollback, profile/data conflicts, late SQL failure,
large-integer fidelity, credential/consent preservation and sequence advancement.


## Runtime boundary

The SQL identity foundation contains immutable one-to-one `(project_id, uid)`
mappings and a monotonic credential-security version. Mapping metadata alone does
not change credential authority. The database advances that version on local password
changes; verified session issuers lock and compare it before minting credentials.

The injected Firebase verifier requires the expected project/UID, recent authentication,
revocation-aware token verification, bounded waits, and sanitized failures. It is
separate from the runtime lifecycle in [firebaseAuthority.ts](../../src/services/firebaseAuthority.ts).
Explicit `AUTH_PROVIDER=firebase` selects that lifecycle for registration, login,
reauthentication, recovery, verification, deletion and session/MCP/Wear reconciliation.
The [backend account-security contract](../../README.md#authentication-and-account-isolation)
owns deployment behavior. Cross-store deletion has durable retry; email matching
cannot claim an existing SQL account. Account import remains an explicit operator
operation under one of the explicit adapter contracts above.

Once provider authority changes, rollback cannot reactivate retained stale local
passwords or restore old SQL over newer tracking data. A real isolated-provider rehearsal
must establish hash import/sign-in compatibility and lifecycle recovery independently
of synthetic tests. Client outage continuity belongs to
[the offline module](../../../mobile/src/offline/README.md).

Run the backend tests `firebase-migration.test.js`, `credential-provider.test.js`,
`firebase-migration-cli.test.js`, and `migration-journal.test.js` for these adapters.
