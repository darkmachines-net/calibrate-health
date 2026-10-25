# Repository tools

Run commands from the repository root; on Windows use `npm.cmd`. Root package scripts
are the supported entry points. Tests, linting, builds and Prisma run on the host.

## Development

Prerequisites are Node.js `22.14+`, `24.3+`, or `26+`, npm, Docker Desktop and
Docker Compose `2.22+`. `npm run dev` starts Docker Desktop on Windows/macOS if
installed but stopped. It installs missing host dependencies, creates an isolated
Compose project, builds the development image, starts Postgres, applies migrations,
seeds deterministic data, and runs backend/Expo web with Compose Watch. It prints
the worktree's stable URLs before attaching the services.

`dev-stack.mjs` owns that lifecycle. Each checkout has its own ports, cookie,
Compose project, image and persistent database volume. Use this launcher rather
than direct `docker compose up`, which bypasses the generated isolation settings.
`dev-env.mjs` owns host dependency caching, Prisma and local CI. Cache identity
includes the lockfile and runtime; setup reports hits and misses explicitly.

Root `.env` holds user-provided application credentials. Generated, ignored
`.dev.env` contains allowlisted application settings and local database/session
credentials and VAPID keys; neither is copied into the development image. GitHub
and Codex tokens are never forwarded to application containers. Rerun `dev`
after changing `.env`; changed environment recreates services. Dependency and
Prisma manifest changes rebuild the affected image through Compose Watch.

| Command | Behavior |
| --- | --- |
| `npm run setup` | Install host dependencies and generate Prisma without starting containers |
| `npm run setup:deps` | Install root/mobile and backend dependencies when cache identity changes |
| `npm run dev` | Prepare and run the stack with seeded-account auto-login |
| `npm run dev:manual-auth` | Run the stack with real login/registration screens |
| `npm run dev:setup` | Prepare images, database, migrations and seed without web/backend |
| `npm run dev:build` | Prepare host dependencies and validate the production web export |
| `npm run dev:status` | Show this worktree's services and URLs |
| `npm run dev:reset` | Reset/reseed only this worktree's database |
| `npm run dev:down` | Remove this worktree's containers/network while retaining its database |
| `npm run db:studio` | Open Prisma Studio against this worktree's database |
| `npm run dev:reset-test-user-onboarding` | Reset setup for the seeded `test@calibratehealth.app` account |

The backend can create seeded data on demand when the database is ready. Use
`dev:manual-auth` to validate ordinary authentication. Migration creation and
application belong to [Prisma](../backend/prisma/README.md); native Metro development
belongs to [mobile](../mobile/README.md#development). `npm run ci:local` runs the
repository's host CI sequence; [quality](../quality/README.md) owns validation policy.

Explicit `FOOD_DATA_PROVIDER` wins. Without it, local development chooses FatSecret
when both credentials exist, otherwise USDA with the supplied key or api.data.gov's
`DEMO_KEY`. Supported providers are `fatsecret`, `usda`, and `openfoodfacts`.

The Codex setup hook copies the source checkout's `.env` once, installs host
dependencies, generates Prisma and allocates ports without starting idle containers.
Codex actions call the same root commands. Environment values are not implicitly
inherited by arbitrary new checkouts outside that setup path.

## Local native workflow

`npm.cmd run native:setup` provisions the pinned Android development tools and host
dependencies on Windows x64. Add `-- --check` for read-only prerequisite inspection.
Development builds and Metro commands are documented beside [mobile](../mobile/README.md).

Protected releases use the shared [Release workflow](../.github/workflows/README.md#release).
`npm run release -- validate` and `npm run release -- plan --profile production`
are read-only checks. Local release, credential-download, submission, OTA publication
and retained-artifact recovery commands have been removed.

`release-inputs.mjs` classifies application source inputs; `release-metadata.mjs`
maintains canonical metadata mirrors; `release-hooks.mjs` supplies application
inspection, stamping, paired Gradle builds and artifact assertions. Selection,
reservations, provider calls and persistence remain in the pinned toolkit.

### Versions, artifacts and installation

The protected command builder uses `native-release-build.mjs` for credential-free
prebuild and paired signed compilation. It retains phone/Wear APKs and AABs with
source, manifest and hash provenance. `native-artifact-checks.mjs` and
`native-runtime-checks.mjs` verify those outputs before publication. Native versions
and odd/even codes come from the shared planner; ordinary feature PRs do not allocate
them. The mobile major is the Expo runtime.

`native-release-devices.mjs` remains a diagnostic worker for explicit targets and
verified artifacts. Its `--help` documents device inspection and optional physical
evidence. [Quality](../quality/README.md#optional-physical-phone-and-watch-protocol)
owns the device protocol. Device evidence does not authorize publication.

## Diagnostics and validation

`npm run test:dead-code` runs comprehensive Knip plus its production graph. Generated
clients and genuine dynamic Expo/Metro entries are configured explicitly. Review
findings before deleting code; do not run Knip `--fix`. Production excludes export/type
findings already checked by the comprehensive pass. `npm run lint:eslint` uses existing
ESLint/JSDoc rules for all authored JS/TS; `npm run test:lint` proves enforcement.

`npm run test:android:e2e` requires an explicit `ANDROID_ADB_SERIAL=emulator-<port>`,
a debug client, Metro and a migrated/seeded disposable backend. Set
`CALIBRATE_E2E_API_URL` to the worktree API; optional email/password/ADB overrides are
supported. The runner clears that emulator's app sandbox and writes synthetic food.
It checks offline persistence through process death, exactly-once reconnect replay,
relaunch and crash absence. Never use personal data or a physical implicit target.

`npm run test:native:upgrade -- --help` describes the same-signer disposable-emulator
rehearsal. Dry-run only discovers/plans. Execute builds trusted baseline/candidate
refs in isolated clones using allowlisted environments and a disposable key, verifies
installed certificates and higher odd/even codes, then uses in-place installs without
clearing data. Package-only mode cannot establish preserved login, pairing or outbox
behavior. Physical validation is optional and documented in [quality](../quality/README.md).
Database rehearsal boundaries live beside [Prisma](../backend/prisma/README.md).

## Operations

Diagnostics are bounded, process-local and disabled by default. Enable
`CALIBRATE_DIAGNOSTICS_ENABLED=true`; add a server-only
`CALIBRATE_DIAGNOSTICS_METRICS_TOKEN` of at least 32 characters to expose
`GET /internal/diagnostics/metrics`. It returns 404 unless configured, 401 for wrong
authentication, and no-store on success. Keep it private at the proxy. Counters reset
on restart. Logs include opaque request/correlation IDs, fixed category/outcome,
method/status and elapsed time, never raw URLs, bodies, health values, identities,
tokens, exception messages/stacks or provider payloads. No external SaaS exporter
is configured by enabling diagnostics.

`operational-alerts.mjs` owns the fixed thresholds, minimum volumes, severity and role
assignments; do not copy that table elsewhere. `operational-alert-collector.mjs`
evaluates deltas from consecutive same-process samples. Run one collector per backend
process every ten minutes, with persistent state; a changed process or an out-of-window
8-12 minute sample rebaselines without alerting. HTTP bodies have a bounded deadline.
An owner-token lock guards concurrent sends; durable pending windows and idempotency
keys survive sink failures, and state advances only after all acknowledgements.

Configure the collector with:

| Variable | Contract |
| --- | --- |
| `CALIBRATE_DIAGNOSTICS_METRICS_URL` | HTTPS private metrics endpoint, no credentials/query |
| `CALIBRATE_DIAGNOSTICS_METRICS_TOKEN` | Matching server metrics token |
| `CALIBRATE_CLIENT_CONFIG_URL` | HTTPS `/api/v1/client-config` endpoint |
| `CALIBRATE_EXPECTED_SERVER_VERSION` | Reviewed deployed server version |
| `CALIBRATE_REMINDER_INTERVAL_MS` | Actual scheduler interval |
| `CALIBRATE_ALERT_STATE_PATH` | Persistent collector-owned file outside web serving |
| `CALIBRATE_ALERT_SINK_URL` | HTTPS alert receiver, no credentials/query |
| `CALIBRATE_ALERT_SINK_TOKEN` | Receiver token, at least 16 characters |
| `CALIBRATE_ALERT_ENVIRONMENT` | `staging` or `production` |

Run `npm run operations:collect` under one scheduler, not overlapping cron/supervisors.
The sink accepts `{environment,idempotency_key,alert}` plus `Idempotency-Key` and returns
2xx JSON `{accepted:true,environment,receipt_id}` with an opaque UUID or 16-64 hex ID.
It must not echo payloads or sensitive data. `npm run test:operations` is network-free;
`npm run smoke:alerts:staging` explicitly tests the configured staging transport.

Dashboards show volume beside failure rates and use fixed categories/operations.
Authenticated joint client event/route/version tuples drive onboarding/vitals alerts;
anonymous root-render reports and separate marginal totals do not establish that volume.
Buckets are not percentile estimates. Expected rejections, conflicts and empty searches
are distinct from failures. Confirm two samples without a reset, compare release
identity, then investigate fixed categories using opaque correlations. Scheduler
staleness and delivery failure need different remediation. Record aggregate outcomes,
not user data; do not change budgets to hide an incident.

Performance baselines are in `quality/performance-budgets.json`. Bundle diagnostics
measure level-9 gzip for the complete reachable hashed/deferred graph, conservatively
shared across routes. Backend benchmarks use fixed fixtures and medians. Use the exact
runtime identities pinned in that manifest when comparing/updating; these are local
diagnostics, not hosted timing gates. Updates require `--update-baseline`,
`--review-reference`, `--owner-role`, `--reviewed-on`, and `--rationale`. Update backend
first, build web, update bundle baseline last, review the diff and rerun without flags.
