# CI and release workflows

YAML and the corresponding workers under `scripts/` own inputs, permissions and
job selection. [Quality](../../quality/README.md) owns validation policy. Required
lint/build/test checks report results on every PR, including README-only changes.
Ordinary feature PRs leave canonical release versions unchanged.

## Pull-request checks

One **Check** workflow reports three stable required checks on every PR, matching
Little Say's workflow shape. There are no path-classification, matrix or aggregation
jobs in the PR checks list.

| Check | Responsibility |
| --- | --- |
| Lint | ESLint with zero warnings, documentation rule tests and Kotlin lint |
| Build | All TypeScript surfaces, dead-code and API contract checks, backend/web builds and Android/iOS JavaScript exports |
| Tests | Release/tooling contracts, fresh Postgres migrations, backend/API/mobile tests and critical desktop/phone browser smoke |

Build uploads the production backend/web output once; Tests restores it and exercises
the same web export. Failures stop their job. Build must succeed before Tests starts,
and all three names are required by the default-branch ruleset. Keep those rule names
in sync when renaming jobs. PR checks run against GitHub's proposed merge commit.
Older runs on a PR retain their old check names; a new commit uses this layout.

**Extended Validation** is manual: choose web, native, web-and-native or
configuration-only for full browser/data-state/UX checks, Android/iOS/Wear compilation,
emulator checks and optional same-signer upgrade rehearsal. **Database Upgrade** is
manual. **Production Container Scan** and **Dependency Audit** are scheduled/manual
maintenance. These workflows do not add checks to ordinary PRs. The shared Release
workflow still owns signed build and delivery validation.

Extended Validation also runs **GCP Configuration**, using `npm run gcp:check` with
mocked Terraform providers and disposable state. It needs no cloud credentials and
does not provision resources. [GCP deployment](../../deploy/gcp/README.md) owns the
bootstrap inputs and the shared-toolkit requirements before changing release destinations.

Validate workflow contracts with `node --test scripts/ci-workflow.test.mjs` and
`npm run test:release`. [Quality](../../quality/README.md) owns the supported diagnostics.

## Release

Merges to protected master run **Release** with the beta profile. The shared toolkit
prepares compatible Android and iOS development clients and hosted updates on the
development channel, reusing compatible clients. Test the exact source and links in
the summary, then approve **Approve tested development candidate for beta**. Only
after approval does it allocate release versions and deliver the server, Android
phone/Wear pair, iOS/TestFlight and beta OTA. Development previews use the existing
backend; server changes become available after approval.

Manual **Release** dispatches select beta or production. Production uses the production
OTA channel and creates Play production-track drafts for both phone and Wear; store
review and rollout remain in Play Console. Beta uses the existing internal tracks.
Both profiles retain iOS/TestFlight delivery; App Store public release remains separate.
The immutable shared workflow and package pin in release.yml and package.json own server, native
and current-runtime OTA selection, version allocation, provider requests and success
baselines. release.config.json owns Calibrate's metadata, paired builder, deployment
and destination configuration. Ordinary PRs leave version mirrors unchanged.

Native compatibility changes select a new mobile major, phone/Wear build pair and iOS EAS build.
Phone codes are odd, Wear codes even, and reservations remain consumed. Expo's runtime
is the mobile major; version stamping does not alter native fingerprints. JavaScript
updates use the current runtime. Native diagnostic identity can also select a server
release. The paired builder verifies application IDs, signing, embedded origins,
runtime/channel and artifact hashes. Phone submission precedes Wear, then iOS.
The shared EAS worker verifies the iOS build identity and submits to TestFlight for
`app.calibratehealth.mobile`, App Store Connect app `6826924944`. The iOS build number
is the reserved phone code; automatic build-number increments stay disabled.

After approval, selected server and native artifacts can build concurrently. Server
changes require successful Cloud SQL migration, verified Cloud Run rollout and
revision-pinned Firebase Hosting health before dependent client publication. Both
profiles deploy to `https://calibratehealth.app`. Production retains its environment
approval. The [GCP deployment guide](../../deploy/gcp/README.md) owns infrastructure,
federation and rollout boundaries.

Use **Re-run failed jobs** after correcting a failure. Retries keep the original plan,
versions and completed artifacts, reuse accepted EAS builds, and skip confirmed
publications, deployments and submissions. Phone/Wear builds still require both
verified artifacts; a successful phone submission is not repeated if Wear fails.
Only confirmed successes advance baselines. Duplicate requests remain prohibited
within an attempt; an unrecorded acknowledgement may cause redundant work on a later
retry or fresh dispatch. See the [toolkit retry contract](https://github.com/darkmachines-net/expo-release-template/blob/main/.github/workflows/README.md#immutable-evidence-and-job-retries).
Existing runs retain their original toolkit pin, so these changes require a new
dispatch after the pin update. There are no candidate/version PRs, retained artifact
commands, promotion commands or historical recovery runners.

## Provider configuration and cutover

Keep the package, lockfile and both workflow callers at the same reviewed full toolkit SHA. The
repository is darkmachines-net/calibrate-health; the toolkit is
[darkmachines-net/expo-release-template](https://github.com/darkmachines-net/expo-release-template).
Keep the existing Expo project, app/store IDs and signing identity. Publish server
images to `ghcr.io/darkmachines-net/calibrate-health` under the repository's current
organization, where its Actions token can own the package. The old personal-namespace
image remains available to existing self-hosted deployments. GCP copies and verifies
the published digest into its dedicated Artifact Registry before rollout.

The existing reviewer-free `preview` environment prepares development clients and
performs approved beta publication. The existing `production` environment gates beta
promotion because approval also authorizes delivery to the deployed backend. Keep
its required reviewers and protected-branch policy; the toolkit rejects a missing
reviewer rule. Public-store publication retains `production` approval and submissions
use the existing protected `play-production` environment.
Both release profiles use `native-release-signing` and `gcp-production`;
beta submissions retain `play-internal`. Keep their existing protections and restrict
protected operations to master. Configure EXPO_TOKEN and the existing assigned Play
credential for phone-beta, wear-beta, phone-production and wear-production submit profiles. Paired
command builds use ANDROID_KEYSTORE_BASE64, ANDROID_STORE_PASSWORD,
ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD. Public Expo inputs must be readable
strings. GCP deployment uses the environment's `GCP_WORKLOAD_IDENTITY_PROVIDER`
and `GCP_RELEASE_SERVICE_ACCOUNT` variables; no long-lived Google key is needed.
EAS also needs the existing iOS distribution certificate, provisioning profile and
assigned App Store Connect submission key. The ios-beta and ios-production submit
profiles both upload to TestFlight; App Store public release remains a separate provider action.

Keep EAS preview and production public variables aligned with their matching
`profiles.*.publicEnvironment` in `release.config.json`. Set
`EXPO_PUBLIC_CALIBRATE_SERVER_URL=https://calibratehealth.app` in the EAS
preview environment for hosted development previews too. That URL is deliberately
not fixed in `development.publicEnvironment`, so local Metro can use the worktree API.
The development variant is set by its build profile; do not set it for beta or production.
The environment
job rejects conflicting remote values before reserving versions or starting builds.
`npm run release -- validate` checks the local configuration; `npm run release --
plan --profile beta` also reads EAS and checks those values. A committed
configuration correction requires a new dispatch after merge because a job retry
keeps the original source and configuration.

This migration starts fresh release history. It imports no old plans, receipts,
pending requests or runtime baselines and requires a new native installation before
OTA. The configured floors are server 0.40.3, mobile 0.2.9 and paired code 18. Existing
phone 17/Wear 18 reservations remain consumed even if Play has accepted lower codes.
Keep the signing key and review the read-only plan before the first dispatch:

`npm run release -- validate`

`npm run release -- plan --profile beta`

Validation does not publish, submit or deploy. The first live release requires
separate owner authorization and verification of native installation, store handoff
and server health.

## Development previews

**Development** is a manual workflow dispatched from master. Choose Android or iOS
and `build` for an installable development client plus matching preview, or `update`
for a preview for an existing compatible client. Source accepts a pushed branch or
full commit SHA; blank uses the dispatch commit. The toolkit resolves it once and
keeps that source on retries. These previews do not advance automatic development
baselines, allocate release versions, submit to stores or deploy the backend.

Provision EAS-managed credentials for `net.darkmachines.healthtracker.development`
and `app.calibratehealth.mobile.development`, and register physical iOS devices for
ad hoc distribution before CI builds. The `ios-simulator` profile extends development.
Both retain the existing Expo project. The Dev
phone has a separate application/signing identity and cannot pair with the store Wear
app; validate that integration with beta's signed phone/Wear pair.

Local previews, Metro and the compatibility gate are documented in
[mobile development](../../mobile/README.md#development). The shared
[consumer contract](https://github.com/darkmachines-net/expo-release-template/blob/main/src/consumer/README.md#development-previews)
owns preview/reuse behavior and credential boundaries. No live preview or release is
part of repository validation.
