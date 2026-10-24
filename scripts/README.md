# Repository tools

Run commands from the repository root; on Windows use `npm.cmd`. Root package scripts
are the supported entry points. Tests, linting, builds and Prisma run on the host.

## Development

Prerequisites are Node.js `22.13+`, `24.3+`, or `26+`, npm, Docker Desktop and
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

`native.mjs` is the entry point for local paired Android phone/Wear packages. Build
once, then install or submit those retained artifacts:

| Command | Behavior |
| --- | --- |
| `npm.cmd run native:configure` | Download EAS signing and assigned Play credentials to external user storage |
| `npm.cmd run native:setup` | Install/check pinned Android tools and host dependencies on Windows x64 |
| `npm.cmd run native:setup -- --check` | Report prerequisites without changes |
| `npm.cmd run native:build` | Credential-free prebuild, signing, and verification of phone/Wear APKs and AABs |
| `npm.cmd run native:install` | Verify/reuse the retained APKs, install and read back device versions |
| `npm.cmd run native:submit` | Verify/reuse the retained AABs, upload to internal tracks and read back acceptance |
| `npm.cmd run ota:publish -- --message "Tested update"` | Publish compatible phone JavaScript/assets to the installed baseline's Expo channel |

Use `npm.cmd run <script> -- --help` for options. Install and OTA are separate optional
operations; after onboarding and a clean committed candidate with unused codes, build
followed by submit is sufficient for local internal distribution. Build does not
allocate versions or run all application tests. Run relevant checks before distributing.

The fixed local profile uses `net.darkmachines.healthtracker`, the private
`https://calibratehealth.darkmachines.net` origin, Expo channel `internal`, and Play
tracks `internal` / `wear:internal`. Devices need WireGuard access. The linked Expo project is
`@calibrate-health/calibrate-health-app`; configuration validates its exact project ID.
[Protected store releases](../.github/workflows/README.md#native-store-releases) use a
fresh higher pair and independent provenance; local uploads cannot be adopted there.

### Credentials and tools

Configure uses the locked EAS CLI in `tools/eas-cli` for authentication and initial
build credential setup, then downloads the default signing key and the Play submission
key assigned to this exact project/package. The FCM key is a different assignment.
Keep the internal EAS credential adapter verified when upgrading that CLI. Configure
does not upload keys, authenticate to Google, or establish Play permissions.

Downloads use a fresh external credentials workspace. Windows settings at
`%LOCALAPPDATA%\calibrate-health\native.json` contain only absolute file paths;
credentials remain in protected `eas-android-*` directories beside it. Other hosts
use `$XDG_CONFIG_HOME/calibrate-health` or `~/.config/calibrate-health`. Invalid or
cancelled downloads preserve the previous configuration. A successful signing-only
download clears stale Play settings when no submission key is assigned. Refresh both
with another configure run after rotation. Retained credential snapshots need protected
backups and must never enter Git. `--service-account-file` is an optional local override.

Build strips inherited signing/Play credentials and reads the selected external signing
file only after prebuild. Install, setup and OTA do not open configured Play keys.
One-run `native:build -- --credentials-file <file>` and
`native:submit -- --service-account-file <file>` override saved paths.

Windows setup requires Node and Git, installs checksum-pinned JDK/SDK/bundletool/NDK/CMake,
and saves user-level `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and `BUNDLETOOL_JAR`.
Current-shell values win. SDK licenses are interactive unless `--accept-licenses` is
supplied; `--skip-deps` handles tools only. Keep strict Gradle locks/checksums enabled.
The phone wrapper is restored by the Expo plugin; Wear has its own pinned toolchain.

### Versions, artifacts and installation

Before reusing already-uploaded codes, run
`node scripts/native-internal-release.mjs prepare --bump patch`, review the synchronized
metadata and commit it with the intended source. The local helper does not query Play
or create authoritative native tags. Phone codes are odd, Wear codes even, globally
unique within the package. Compatible OTA-only changes need no native bump.

Build requires a clean committed source and records all four artifacts:

| Artifact | Path |
| --- | --- |
| Phone APK | `mobile/android/app/build/outputs/apk/release/app-release.apk` |
| Phone AAB | `mobile/android/app/build/outputs/bundle/release/app-release.aab` |
| Wear APK | `wear/app/build/outputs/apk/release/app-release.apk` |
| Wear AAB | `wear/app/build/outputs/bundle/release/app-release.aab` |

Retain `build/native-release-provenance.json`, `build/native-local-internal.json`, and
`mobile/android/app/build/outputs/calibrate-ota-baseline.json` with those outputs.
Install/submit reject changed source, bytes, identity, versions or configuration.
Manual Console uploads use the printed `local-p@<full-commit>` and `local-w@<full-commit>`
release names and must expose each exact singleton code as completed.

Installation discovers both devices or accepts `--phone-serial` and `--watch-serial`.
It uses `adb install -r`, rejects downgrades, launches unless `--no-launch`, and verifies
installed versions. Signer mismatch needs explicit replacement consent;
`--replace-incompatible` authorizes uninstall and local-data loss. Play may sign
installed APKs with a different key from the upload key, so use Play updates after
that migration rather than expecting local upload-key APKs to replace them.

## Play onboarding

Create the Play app for the exact package, enable Wear under the same listing, enroll
both form factors in Play App Signing and configure internal testers/opt-in links.
The first upload binds the package. Keep the registered upload key; replacing it is
a separate rotation. Finish Console-required content, health, privacy and deletion
declarations from the [current implementation](../mobile/src/legal/README.md), not a
saved worksheet. A private WireGuard backend is not accessible to public reviewers.

For local API submission, enable Google Play Android Developer API and grant a service
account access only to this app with read app information and testing-track release
permissions. Assign its JSON in EAS under this package's **Play Store Submissions**
credential, then rerun configure. Do not grant local testing credentials production
permission. Organization key-creation policy may require an organization administrator;
project ownership alone does not override it.

Before submission coordinate other Console/API writers and inspect Publishing overview:
an API edit can include unrelated pending Console changes. The public submit command
prints a reminder and supplies the internal acknowledgement without another prompt.
It uploads only the verified pair to `internal` / `wear:internal` and reads back versions/hashes;
it does not promote to closed testing or production. After distribution, exercise
pairing, foreground/background sync, reconnect, permissions and in-place Play updates
using synthetic data. Keep actual release evidence with the release record.

## OTA

`npm.cmd run ota:publish -- --dry-run --message "Tested update"` resolves the source
fingerprint and validates channel/EAS environment configuration without publishing.
Omitting `--dry-run` publishes. The last local build record supplies targeting defaults;
`--baseline <file>` selects another retained record. Without one, provide the configured
Expo project, channel and server origin. Only matching runtimes receive the update;
publication may precede installation or Play acceptance of that native runtime.
Older appVersion installations need a new native binary to migrate.

Authenticate with the locked EAS CLI, or `EXPO_TOKEN` and `--non-interactive`.
The baseline's internal channel uses EAS preview; explicit channel/environment inputs
must satisfy the configured targeting contract. Native inputs require matching native
packages; OTA never updates Wear. Publication proves Expo availability, while device
download and full close/reopen establish application.

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
