# CI and release workflows

YAML and the corresponding workers under `scripts/` own inputs, permissions and
job selection. [Quality](../../quality/README.md) owns validation policy. Required
lint/type/test checks report results on every PR, including README-only changes.
Ordinary feature PRs leave canonical release versions unchanged.

## Pull-request check selection

[`scripts/ci-changes.mjs`](../../scripts/ci-changes.mjs) owns the shared selection
policy. Classifiers use the complete merge-base-to-head Git diff, including deleted
files and both sides of renames. They require no dependency installation and print
their decisions in the Actions summary. A missing Git baseline fails classification;
an unreadable dependency graph conservatively selects native compilation.

| Checks | PR inputs |
| --- | --- |
| ESLint and dead-code checks | Authored JS/TS, dependency/configuration and workflow changes |
| Kotlin lint | Kotlin sources, Gradle wrapper and the isolated lint tool |
| Type checking | Affected backend, shared, API client and mobile surfaces |
| Release configuration/tooling tests | Release manifests, API contracts, workflow/tooling, deployment and quality policy inputs |
| Backend tests/build | Backend/shared changes; test-only changes skip the build |
| Mobile tests and API contract | Mobile/shared/API changes; API generator installation and contract checks run only for contract/dependency inputs |
| Web export and critical smoke | Web runtime, assets, dependencies and build/smoke configuration; smoke reuses the exact exported artifact |
| Android/iOS Metro bundles | Native JavaScript, shared code, dependencies and bundler configuration |
| Android/iOS compilation | Native modules/plugins, app configuration, Gradle locks/wrapper, packaged icons, patches, install hooks and changed mobile dependency graph; platform-specific inputs select only that compiler |
| Wear build/JVM tests | Watch sources and build configuration |
| Production image smoke/OS scan | Production backend/web inputs and Docker configuration |
| Populated database upgrade | Prisma, database integration code and upgrade/backup tooling |
| Historical upgrade/rollback | Migration files and rollback tooling |

Documentation does not select application checks. JS/TS unit-test-only changes retain
their test/lint checks without rebuilding packages or the production image. Web-only
modules skip native bundles, and native-only modules skip web/image checks.
Root tooling-only lockfile updates do not compile native apps when the mobile
production graph is unchanged. Dependency identity includes resolved versions,
integrity, peers, workspace links and hoisting. Changes within that graph remain
conservative: a package may contain native code or affect prebuild even when its name
does not identify it as native. This is CI selection, not an OTA compatibility proof.

Editing a workflow selects its checks; editing the classifier selects all affected
lanes. Workflows remain triggered for every PR so required check names report a
result even when their work is irrelevant. Manual validation scopes retain their existing full-validation rules. Exhaustive
browser/UX suites, emulators and package-upgrade rehearsals remain manual; dependency
audits remain scheduled/manual.

Validate selection with `node --test scripts/ci-changes.test.mjs` and workflow/release
contracts with `npm run test:release`. Add representative inclusion and exclusion
cases when adding an input surface.

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
changes require completed webhook deployment health before dependent client publication.
Production retains its environment
approval. The [deployment guide](../../deploy/self-hosted/README.md) owns private
routing, webhook configuration and health semantics.

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
Keep the existing Expo project, app/store IDs, signing identity and
`ghcr.io/mchartier/calibratehealth` image destination. Verify package Actions write
access for the transferred repository before dispatch.

The existing reviewer-free `preview` environment prepares development clients and
performs approved beta publication. The existing `production` environment gates beta
promotion because approval also authorizes delivery to the deployed backend. Keep
its required reviewers and protected-branch policy; the toolkit rejects a missing
reviewer rule. Public-store publication retains `production` approval and submissions
use the existing protected `play-production` environment.
Both release profiles retain `native-release-signing` and `self-hosted-testing`;
beta submissions retain `play-internal`. Keep their existing protections and restrict
protected operations to master. Configure EXPO_TOKEN and the existing assigned Play
credential for phone-beta, wear-beta, phone-production and wear-production submit profiles. Paired
command builds use ANDROID_KEYSTORE_BASE64, ANDROID_STORE_PASSWORD,
ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD. Public Expo inputs must be readable
strings. WireGuard configuration retains its DEPLOY_* names in the deployment guide.
EAS also needs the existing iOS distribution certificate, provisioning profile and
assigned App Store Connect submission key. The ios-beta and ios-production submit
profiles both upload to TestFlight; App Store public release remains a separate provider action.

Keep EAS preview and production public variables aligned with their matching
`profiles.*.publicEnvironment` in `release.config.json`. Set
`EXPO_PUBLIC_CALIBRATE_SERVER_URL=https://calibratehealth.darkmachines.net` in the EAS
preview environment for hosted development previews too. That URL is deliberately
not fixed in `development.publicEnvironment`, so local Metro can use the worktree API.
The development variant is set by its build profile; do not set it for beta or production.
The environment
job rejects conflicting remote values before reserving versions or starting builds.
`npm run release -- validate` checks the local configuration; `npm run release --
plan --profile production` also reads EAS and checks those values. A committed
configuration correction requires a new dispatch after merge because a job retry
keeps the original source and configuration.

This migration starts fresh release history. It imports no old plans, receipts,
pending requests or runtime baselines and requires a new native installation before
OTA. The configured floors are server 0.40.3, mobile 0.2.9 and paired code 18. Existing
phone 17/Wear 18 reservations remain consumed even if Play has accepted lower codes.
Keep the signing key and review the read-only plan before the first dispatch:

`npm run release -- validate`

`npm run release -- plan --profile production`

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
