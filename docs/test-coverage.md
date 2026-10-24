# Test Coverage

This repo has automated tests for the backend and the shared Expo web/Android client, plus
targeted Kotlin/JVM and device checks for the Wear client:

- `npm run test` runs backend, API client, and Expo client tests.
- `npm run lint` runs ESLint with `--max-warnings 0`, then type-checks backend, shared domain, API client, and Expo sources and rejects unused locals or parameters.
- `npm run test:lint` verifies lint coverage and failure on warnings, errors, and obsolete suppressions. The **Lint** workflow runs **ESLint (zero warnings)** on every PR, and release candidate validation requires it to succeed.
- `npm run test:coverage` runs backend `c8` coverage and Expo client Jest coverage.
- Package-specific commands include `test:backend`, `test:api-client`, `test:mobile`,
  `test:coverage:backend`, and `test:coverage:mobile`. Wear JVM tests run from the Gradle project
  with `wear/gradlew testDebugUnitTest`; a non-debuggable APK smoke runs against an adb watch target
  with `npm run test:wear:emulator`. The optional manually dispatched hosted Wear lane then removes
  the differently signed release package and runs `:app:connectedDebugAndroidTest` on the same
  disposable emulator for Room migrations, encrypted token persistence, and account-scoped cleanup.
  PR builds compile and run the Wear JVM suite independently of the longer phone build.
- `npm run test:db:upgrade` applies migrations through `0020` to an isolated schema, inserts
  representative account/goal/weight/food data, upgrades through current, verifies retention, and
  removes only that generated schema. Its helper tests run without Postgres.
- `npm run test:db:backup-restore` creates uniquely named local Docker resources, runs the real
  encrypted production backup and guarded restore scripts, compares representative food, weight,
  and activity rows, rejects plaintext artifacts, and removes only resources owned by that run.
  `npm run test:db:backup-restore:unit` validates its safety guards without Docker.
- `node scripts/postgres-rollback-smoke.mjs` starts only owned disposable local resources, seeds the
  immutable `v0.14.0` schema through migration `0031`, creates a production age-encrypted backup,
  upgrades through `0038`, restores the exact predecessor into a new empty target, and re-upgrades
  the restored data. Its dependency-free contract suite is
  `node --test scripts/postgres-rollback-smoke.test.mjs`; the full protocol and retained evidence
  shape are documented in [`database-rollback-rehearsal.md`](database-rollback-rehearsal.md).
- `npm run test:web:e2e` builds the Expo web release export, serves it from a loopback static
  server, and runs the critical browser path in the machine's installed Chrome. API routes are
  deterministically fulfilled by the suite. It does not download a Playwright browser or add the
  suite to the long-running CI path.
- `npm run test:risk-evidence` quickly validates the six risk areas, their concrete test files and
  root npm scripts, and the verifier itself. It does not rerun the referenced product suites or
  act as a release gate.

The browser suite exercises signed-out and authenticated shells across desktop, tablet, and phone
viewports; deep-link reloads; offline/recovery UI; release-surface navigation; and an offline weight
write that survives reload and replays exactly once. `PLAYWRIGHT_CHROME_CHANNEL` or
`PLAYWRIGHT_CHROME_PATH` can select another locally installed Chromium build.

## Current Coverage Shape

Backend coverage is broadest today. It includes route-level tests for the main API surfaces plus utility/service tests for profile math, food provider normalization, imports, local dates, notifications, weights, and goal rules.

Expo client coverage focuses on domain logic that has the highest risk of silent regressions:

- timezone-aware local-day helpers;
- goal progress and projection math;
- onboarding unit conversions and goal-mode inference;
- web onboarding, food logging, goals, Settings, profile photo, notification, and PWA interactions;
- serving snapshot label formatting;
- locale-based unit defaults;
- offline operation replay and account isolation;
- Health Connect normalization, checkpoints, permissions, and account cleanup;
- Wear pairing, handoff, invalidation, and deleted-account cleanup.

## Risk-based diagnostic inventory

Global line coverage is diagnostic, not the release target. Generated clients, native bridges, and
platform callbacks can move a single percentage without changing the risk of losing or exposing a
user's data. Reviews and releases use the following evidence targets instead:

[`quality/risk-evidence.json`](../quality/risk-evidence.json) is the machine-readable evidence map
for these targets. The verifier requires all six areas and their capabilities, checks that every
referenced evidence file is non-empty, validates exact root npm commands and workflow references, and
rejects malformed or weakened diagnostic gaps. It intentionally does not infer quality from a global line
percentage.

| Risk area | Required automated evidence |
| --- | --- |
| Authentication, session rotation, pairing, account deletion, and authorization | Success, invalid/expired credential, replay/idempotency, revocation, and cross-account denial tests at the service or route boundary |
| Offline writes, synchronization, Health Connect checkpoints, and watch reconciliation | Durable retry, duplicate replay, stale revision/conflict, account/server isolation, and reconnect tests with deterministic operation IDs |
| Database schema and data portability | Fresh migration, supported upgrade path, representative export, cascade deletion, encrypted backup validation, and clean restore evidence |
| Food, weight, goals, and activity calculations | Unit, timezone/local-day, boundary-value, immutable snapshot, and API serialization tests |
| Privacy-sensitive configuration and diagnostics | Permission/config assertions plus tests that logs, metrics, exports, and errors omit credentials and unnecessary health detail |
| Web, Android, and Wear critical workflows | Component/unit coverage for state transitions and at least one end-to-end happy path plus failure/offline path on the supported runtime |

Changes to authentication, synchronization, persisted data models, permissions, imports,
uploads, exports/deletion, or diagnostic output should add or update focused tests when practical.
The inventory describes coverage; it does not create a second approval system.

Physical Galaxy phone and Galaxy Watch Ultra coverage is represented as a non-blocking diagnostic gap tracked in
issues `#219`, `#222`, and `#303`. When physical validation is useful, an optional sanitized JSON result can replace
that gap for the tested source commit. No evidence-only commit or release-mode verifier is required. The focused
execution path and optional result shape are documented in
[`physical-galaxy-validation.md`](physical-galaxy-validation.md).
The existing Wear emulator command proves launch, package/permission state, unpaired guidance, Tile
registration, and crash absence; it is deliberately not recorded as a paired tracking happy path.

Coverage reports remain useful for finding unexercised modules and unexpected drops. Raising or
adding a numeric package threshold should follow measured baseline cleanup rather than encouraging
low-value tests that merely execute lines.
