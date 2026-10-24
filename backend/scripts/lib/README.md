# Offline identity migration preparation

[firebaseMigration.ts](firebaseMigration.ts) and [migrationJournal.ts](migrationJournal.ts)
provide a dry-run-first, injected migration engine and a single-host durable journal.
They do not activate Firebase, acquire live accounts, or ship a live apply adapter.
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
No live acquisition is implemented here. The destination input must enumerate
all identities, including identities without email; an empty list means the
operator supplied an empty snapshot, not that Firebase was inspected. Inventories
contain credentials and must remain in protected operator storage, never Git,
PR attachments, or ordinary logs. This task's tests use synthetic data only.

`preservationDigest` must bind the canonical ownership/access snapshot collected
by the future source adapter: owned-row identities and content, verification
timestamp/history, onboarding state, and genuine legal acceptances. The planner
only checks its format and detects changes; it cannot establish completeness or
preservation from a digest supplied by a caller. A live adapter and independent
before/after SQL reconciliation are still required.

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
engine for future operator tooling. **No live apply adapter is shipped.** The
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
  future transaction must install a uniquely constrained immutable project/UID
  mapping against the unchanged User.id. Retain the local hash under the agreed
  rollback policy without permitting fallback after authority changes.

The engine refuses a plan with any held account. This makes resolution explicit;
an operator must not silently omit difficult accounts to produce a green plan.


## Runtime boundary

The SQL identity foundation contains immutable one-to-one `(project_id, uid)`
mappings and a monotonic credential-security version. It does not change credential
authority. The database advances that version on password changes; MCP approval
locks and compares it before minting a code. `AUTH_PROVIDER` must remain `local`.

The injected Firebase verifier requires the expected project/UID, recent authentication,
revocation-aware token verification, bounded waits, and sanitized failures. It is
never selected by runtime endpoints. Before any activation, registration, login,
reauthentication, recovery, verification, deletion, session/MCP/Wear revocation and
external security-event reconciliation must use the same authority. Cross-store
deletion needs durable retry; email matching cannot claim an existing SQL account.

Once provider authority changes, rollback cannot reactivate retained stale local
passwords or restore old SQL over newer tracking data. A real isolated-provider rehearsal
must establish hash import/sign-in compatibility and lifecycle recovery independently
of synthetic tests. Client outage continuity belongs to
[the offline module](../../../mobile/src/offline/README.md).

Run the backend tests `firebase-migration.test.js`, `credential-provider.test.js`,
`firebase-migration-cli.test.js`, and `migration-journal.test.js` for these adapters.
