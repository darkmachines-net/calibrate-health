# Offline tracking workspace

SQLite on native and IndexedDB on web persist intent by exact server origin and
user ID. Cached identity and tracking queries provide local continuity, never server
authorization. Network/provider outages, 429, timeouts and retryable 5xx preserve
credentials, cache and pending writes across restart. Confirmed rejection stops
server replay; explicit logout/deletion cannot be reversed by cached identity.
Native restore also requires the retained refresh credential.

## Dispatch and replay

Allocate a stable operation ID before the first attempt and retain the exact payload
on retry. Every producer reads durable intent under the namespace dispatch lock.
Web Locks serialize tabs; without them, web writes queue but cannot safely replay.
Native serialization is per runtime. Reopening plus dependent food creation holds
the same lock, preventing completion from overtaking queued food in another tab.

The FIFO preserves uncertain commits through process death. A terminal head failure
blocks later replay. Unrelated local work remains durable behind it. Insertion guards
reject related corrections while an earlier operation failed. Food recovery groups
one entry, weight recovery one day, and pause/day controls a coordinated set.
Retry reuses original identity; explicit confirmed discard removes only the reviewed
intent transactionally, rejects stale confirmation, and never claims to undo a write
that might already have reached the server. Successful discard resumes reconciliation.

## Projection and acknowledgement

Tracking views overlay ordered durable intent on cached server rows. Synthetic negative
IDs are local only. Dependent edits/deletions preserve the original creation request
and recover its server receipt before using a real ID. Conflicts never guess a mapping.
Snapshots commit acknowledged rows before dequeueing intent so restart cannot lose
visible results. Server-owned targets and trends remain pending until synchronization.
Only previously loaded data works offline; search, uncached history and security
operations still require a connection. Legacy saved-food intent without a nutrition
snapshot stays reviewable without inventing zero calories.

Mutation responses are acceptance receipts, not current day/pause state. Control replay
verifies current server state before recording local receipts and removing requests;
unavailable verification keeps the original request pending. Fresh pause snapshots
replace stale indefinite projections without erasing queued explicit resume intent or
independently verified day states. Reads reconcile under the same namespace lock.
Only explicit historical Backfill or fresh server-day evidence overrides a covering
pause; its local marker never enters the API payload. Today requires Resume tracking.

## Account and logout boundaries

Generation checks prevent async hydration or replay crossing an account/server switch.
Recovery must authenticate the same account before sending its queue. Persisted explicit
logout intent blocks automatic startup restoration and retries server revocation on
reconnect/foreground/startup. New login first completes pending revocation. Browser
storage never contains the HttpOnly credential; native pending tokens remain in
SecureStore. Late refresh responses are revoked instead of restoring a signed-out session.
If both durable sign-out storage and networking fail, explain the restart limitation
and retain in-process intent; do not claim durable logout in that state.

## Validation

Colocated tests cover dispatch locks, store transactions, retry/discard, projection,
account isolation and restart. `e2e/expo-web/offline-workspace.spec.ts` exercises
the exported UI with synthetic API fixtures. `npm run test:android:e2e` exercises
an explicit disposable emulator and real backend. Browser/component evidence does
not establish physical-device behavior.
