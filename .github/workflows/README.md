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

Run **Release** from protected master with the beta or production profile. The immutable
shared workflow and package pin in release.yml and package.json own server, native
and current-runtime OTA selection, version allocation, provider requests and success
baselines. release.config.json owns Calibrate's metadata, paired builder, deployment
and destination configuration. Ordinary PRs leave version mirrors unchanged.

Native compatibility changes select a new mobile major and phone/Wear build pair.
Phone codes are odd, Wear codes even, and reservations remain consumed. Expo's runtime
is the mobile major; version stamping does not alter native fingerprints. JavaScript
updates use the current runtime. Native diagnostic identity can also select a server
release. The paired builder verifies application IDs, signing, embedded origins,
runtime/channel and artifact hashes. Phone submission precedes Wear submission.

Selected server changes publish the image and require completed webhook deployment
health before dependent client publication. Production retains its environment
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

Keep the package, lockfile and workflow at the same reviewed full toolkit SHA. The
repository is darkmachines-net/calibrate-health; the toolkit is
[darkmachines-net/expo-release-template](https://github.com/darkmachines-net/expo-release-template).
Keep the existing Expo project, app/store IDs, signing identity and
`ghcr.io/mchartier/calibratehealth` image destination. Verify package Actions write
access for the transferred repository before dispatch.

The production profile uses production approval, native-release-signing,
play-production and self-hosted-testing environments. Beta uses preview and play-internal instead. Create their protections before
dispatch and restrict protected operations to master. Configure EXPO_TOKEN and the
existing assigned Play credential for the phone-beta, wear-beta, phone-production and wear-production submit profiles. Paired
command builds use ANDROID_KEYSTORE_BASE64, ANDROID_STORE_PASSWORD,
ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD. Public Expo inputs must be readable
strings. WireGuard configuration retains its DEPLOY_* names in the deployment guide.

Keep the EAS production public variables aligned with
`profiles.production.publicEnvironment` in `release.config.json`. The environment
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

## Development and beta

**Development → build** produces a separate Calibrate Dev phone client through EAS, without reserving a phone/Wear release pair or submitting to stores. IDs are net.darkmachines.healthtracker.development on Android and app.calibratehealth.mobile.development on iOS. Configure their EAS signing first; physical iOS development builds require registered devices. The existing ios-simulator profile extends development.

Dispatch **Development** from **master**. In **Source**, enter a pushed branch name (for example, `codex/my-change`) or a full commit SHA; leave it blank to use the master dispatch commit. The toolkit resolves a branch once to an immutable commit and preserves that commit on retries, even if the branch moves.

After installation, `npm run preview -- --platform android` (or ios) exports your current working copy, including uncommitted changes, to an isolated preview branch and prints its dashboard/QR link. EAS CLI 25.3.0 and EAS login are required. `npm run dev:native` starts local Metro with the same development identity. The previous backend/web preview command remains available as `npm run preview:web`. See the [shared development contract](https://github.com/darkmachines-net/expo-release-template/blob/main/src/consumer/README.md#development-previews) for the single source of preview behavior and compatibility rules.

Beta and production have separate persistent OTA channels. Beta submits the existing phone/Wear pair to internal and wear:internal; production uses production and wear:production drafts, with the existing play-production credential environment. Beta and development use the existing preview approval environment. Protect it for the intended testers before running hosted previews. Public store release still requires provider review/completion. Calibrate's store pipeline remains Android phone/Wear; an iOS development client does not add a TestFlight store-release target. Validate paired watch integration in beta, since the development phone has a distinct application ID.
