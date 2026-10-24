# Release compatibility and artifact provenance

`shared/release.json` is the canonical release manifest for the server, the shared Expo mobile compatibility line,
the Android app, and the Wear OS app. Android and iOS Expo clients share its semantic mobile version and minimum-version
policy; Expo config and client-diagnostic allowlists mirror those values. Android build files also mirror the manifest
because Expo and Gradle need native values before application code runs; `npm run release:check` fails quickly when any
mirror drifts.

## Compatibility policy

Calibrate uses semantic `version_name` values for compatibility decisions and positive, monotonically increasing
Android `version_code` values for upgrades. A self-hosted server should support every API listed in
`server.api.supported`. It may raise a minimum client version only when older releases cannot operate safely or
correctly; routine feature additions should remain backward compatible.

The Android native version remains independent from the server/web version. Each JavaScript bundle separately carries
the `shared/release.json` server version whose contract it expects. Bundle and server major versions must match.
Within a major, an older client minor remains compatible with a newer server minor because the server remains backward
compatible. A newer client minor is incompatible with an older server minor because required additions may be
missing. Patch drift remains compatible. This directional boundary protects a self-host whose deployment can lag OTA
publication, even when the v1 wire changes are additive.

For example, these running-bundle checks follow `shared/releaseCompatibility.ts`:

| Bundled server contract | Selected server | Result |
| --- | --- | --- |
| `0.35.0` | `0.35.2` | Compatible; patch differences do not block use. |
| `0.34.0` | `0.35.0` | Compatible; the server supports the older client minor. |
| `0.35.0` | `0.34.0` | Blocked; update the selected server before using this bundle. |
| `0.35.0` | `1.0.0` | Blocked; the client and server majors must match. |
| `1.0.0` | `0.35.0` | Blocked; the client and server majors must match. |

These are runtime results, not promises about whether Expo downloads or launches an update. During production
approval, compare the candidate bundle's contract with the release owner's intended server rollout. An approval
cannot establish compatibility for independently managed self-hosts, so each device must still perform its own
uncached check before restoring a session or synchronizing. Do not replace that check with private-server polling
from CI or require equal minor versions when the server minor is newer.

The server returns `/api/v1/client-config` with `Cache-Control: no-store`. Before saving a server, refreshing a saved
session, or manually rechecking compatibility, the phone also requests it with Fetch `cache: 'no-store'`. It refuses
an unsupported API, an incompatible server contract version, or a native release older than
`min_supported_mobile_version` with actionable guidance. Native phone and Wear HTTP
requests also send `X-Calibrate-Client-Platform` plus `X-Calibrate-Client-Version`. The server compares the trusted
bearer-session platform with those headers on every authenticated request and requires Wear identity during the
one-time pairing exchange. Browser cookie sessions omit these headers and are unaffected.

Expo retains its normal update lifecycle; the client does not veto an update download based on the selected server.
If an incompatible bundle starts, the runtime preflight blocks normal authenticated use before session refresh and
synchronization. When a server change is selected, both OTA channels require its Compose upgrade
and application health check to succeed. An unselected server requires no deployment or health request. This checks only that target's health, not an exact server/OTA version
match; independently managed self-hosts still rely on the runtime mismatch guard.

An incompatible native request receives HTTP 426 with `CLIENT_UPGRADE_REQUIRED`, the applicable minimum version, and
a non-retryable user message. Phone keeps its credentials and offline outbox behind an update-required screen. Wear
keeps pairing, cache, and queued mutations but stops normal refresh/action work behind a dedicated update-required
state. Foregrounding that Wear screen schedules a bounded compatibility probe; a committed compatible snapshot clears
only the upgrade marker and then resumes retained queued work. This allows either an in-place watch update or a server
rollback that lowers the client floor to recover without re-pairing or discarding local data. A platform header cannot
override the device platform retained by the authenticated server session.

Compatibility changes follow these rules:

- Additive API and database changes remain compatible with the current API version.
- A breaking wire change requires a new API version while the old version remains in `supported` during migration.
- Raising a minimum client version is a last-resort safety boundary and must be called out in release notes.
- Phone and Wear artifacts must keep application ID `net.darkmachines.healthtracker` and use the same signing certificate
  for Wear Data Layer communication.
- Phone and watch use a shared native version, independent of server/web, and globally unique odd/even version codes.

## Channels

| Channel | Phone artifact | Wear build type | Intended use |
| --- | --- | --- | --- |
| `debug` | Local Expo/Gradle debug | `debug` | Emulator and development devices only |
| `internal` | Locally signed release APK | `internal` | Owned-device validation before store release |
| `production` | Locally signed release AAB | `release` | Store-distributed release |

The internal Wear build uses shared release signing when all `CALIBRATE_ANDROID_SIGNING_*` values are supplied and
falls back to the repository debug key for local phone-debug pairing. `npm run native:build` supplies the same
validated signing environment to the phone and Wear release builds. Any future EAS-built phone artifact can pair only
with a Wear artifact signed by that same certificate. Never place signing material in `shared/release.json` or
generated metadata.

Store delivery is selected by Cut release from phone fingerprint and Wear build-input changes. It builds and attests
one pair, queues the exact phone AAB through EAS Submit to internal, permits runtime-targeted OTA, and independently finishes
phone submission before Wear submission to wear:internal. Explicit promotions reuse exact attested codes and AAB hashes.
No signed native tag or Play acceptance is required for OTA. See [the unified release runbook](native-store-release.md).

## Explicit server/web releases

Ordinary feature and fix PRs must not change `server.version` or its package, diagnostic, OpenAPI, generated-client,
or lockfile mirrors. Merge the desired changes to `master`, then run **Cut release** from the GitHub Actions page and
choose the semantic component to advance:

- `patch` for compatible fixes: `X.Y.Z` to `X.Y.(Z+1)`.
- `minor` for compatible features: `X.Y.Z` to `X.(Y+1).0`.
- `major` for breaking server, API, or deployment contracts: `X.Y.Z` to `(X+1).0.0`.

The three manual Actions entries are read-only request workflows. They upload a small request bound to the exact
successful `master` run; a `workflow_run` handler loaded from default `master` revalidates that request before calling
the reusable worker. Use the existing repository configuration:

1. Enable **Allow GitHub Actions to create and approve pull requests** in the repository's Actions settings.
   The default workflow token can remain read-only; each publishing job declares its required permissions.
2. Keep the existing `master` pull-request protection. Release finalization uses GitHub's PR merge API and obeys
   repository rules. Additional required reviews or checks must be satisfied before merging.
3. Give this repository Write access to the `calibratehealth` GHCR package under **Manage Actions access** (or retain
   its inherited repository access). The image publisher authenticates with its ephemeral `GITHUB_TOKEN` and
   `packages: write`. A dedicated Server Release GitHub App, GHCR robot, custom publication environment, and extra
   server tag rulesets are not prerequisites.
4. Retain the configured `EXPO_TOKEN` repository secret and the `preview` and reviewer-protected `production`
   environments for OTA. The first integrated release creates a fingerprint native baseline; OTA waits for build success and phone enqueue, not Play acceptance.

Candidate preparation, validation, and image construction use read-only repository tokens with no registry write
permission. Separate publication jobs receive only the permissions needed for their operation: Contents write for
candidate branches and stable tags, Contents and Pull requests write for finalization/cleanup, Checks write only for
attaching verified CI results to the release candidate during finalization, and Packages write
for GHCR. The image-receipt signer has only Contents read, OIDC write, and Attestations write and runs the full-SHA-pinned
attestation action before package authentication. Source-owned build commands never run on the package publisher.
The publisher verifies artifacts and current workflow authority with reviewed tooling before logging into GHCR.

These job boundaries limit accidental credential exposure in the reviewed workflow. They are not an external
capability boundary against someone allowed to edit or rerun workflows with write permissions. The App/robot design
was a stronger, optional security migration that required separate onboarding; this flow uses the configured Actions
identity instead. Existing branch protection and the production approval remain in force.

Before package authentication, the build's deterministic receipt binds the GitHub repository, GHCR repository,
release tag, release commit, and Docker image config digest. The isolated signer attests those exact bytes before any
registry mutation. Recovery reconstructs the same receipt from the config digest of the exact observed single
linux/amd64 registry manifest and verifies it with a checksum-pinned GitHub CLI against the exact repository, signer
workflow path, signer revision, source revision, and `refs/heads/master`. The freshness-verified workflow revision is
trusted automatically. A receipt from an earlier protected-master revision remains usable across unrelated commits only
when every security-critical image workflow/verifier blob is byte-identical, or when it is the exact post-hardening
parent of the verified canonical Cut release commit. Current protected `master` can retain a changed historical signer
with `allow FULL_SHA`, or override every automatic rule with `revoke FULL_SHA`, in
`.github/release-image-attestation-trusted-workflow-shas`. Keep required changed signers allowed for the full supported
image/OTA recovery window, and review removals or explicit revocations as release-key revocations. Pre-hardening
revisions, off-master revisions, changed unlisted revisions, and explicitly revoked revisions fail closed.

GitHub certificates distinguish the reusable signer (`container.yml`) from the top-level build configuration
(`cut-release-handler.yml`, `publish-release-handler.yml`, or `container-handler.yml`). Both must name this repository
at the same exact protected-master revision, and the caller must use `workflow_run`. Treating the two workflow paths
as identical rejects valid receipts and prevents recovery after the initial image push.

The GitHub attestation store is an integrity authority, not an availability boundary. The verifier uses an explicit
bounded high lookup limit so unrelated attestations cannot exhaust the default result window, then re-verifies the
authorized certificate with its exact signer and source digest. An actor or workflow with `attestations: write` may
still flood or delete records. Missing, deleted, or invalid legitimate receipt evidence therefore fails closed before
alias fill or `latest` mutation; quarantine/delete the blocked immutable aliases after an owner audit and perform a
fresh build/attestation/publication rather than trusting the registry bytes.

Server candidate publication, validated PR merge, tag creation, and GHCR publication run automatically. No new server
publication environment approvals are required. If validation or finalization fails before merging, read-only
inspection first proves the candidate PR/branch still belong to the action. Candidates that passed metadata/smoke
validation are retained for CI repair and failed-job retry with unchanged refs; cleanup is limited to exact unmerged
candidates that did not pass that validation. **Publish prepared release** and **Build Release Image** also run without a server environment gate.

The action requires the checked manifest version to equal the highest stable tag, prepares every server/web mirror on
`release/vMAJOR.MINOR.PATCH`, and validates that exact commit. It verifies the candidate parent and identity,
synchronized release configuration, and exact canonical server/native mirror set. It also builds and starts the production image,
then checks readiness and the served web application. The trusted release run calls the existing lint, test, release
configuration, production-image OS scan and populated database upgrade workflows with explicit candidate/source SHAs.
These jobs receive read-only permissions and no publication/provider secrets. Canonical version-only candidates keep
platform builds and migration rollback skipped; normal PR and manual workflow selection stays unchanged.
Package dependency audits run only during weekly or
manual maintenance and do not gate a release cut. Full container scans include package libraries only during
scheduled/manual maintenance; PR scans retain OS-vulnerability checks. If `master` advances while validation runs, the
candidate is not merged; explicitly reconcile the retained candidate before starting another cut.

After validation, the action creates a version-only release PR and verifies the parents and tree of GitHub's proposed
merge. Both the initial CI gate and its immediate premerge recheck require successful exact-candidate jobs from the
same trusted run and verified workflow source. Failed-job retries may reuse earlier successes only from that run and
candidate; newer failures cannot fall back to older green jobs. Missing, failed, cancelled or wholly skipped required
validation blocks finalization without waiting for approval of token-created PR workflows.
After verification, finalization publishes **ESLint (zero warnings)**, **Backend, Shared, API Client, and Mobile
Typecheck**, and **Required Tests** on the exact candidate. Each check links to the trusted run; these satisfy the
same required-check rules as ordinary PR jobs without bypassing branch protection.
It rechecks `master` immediately before calling the PR merge API with the exact validated head SHA. The API
honors branch protection and locks the head, but does not offer a base-SHA compare-and-swap. The workflow therefore
checks the actual merged parents, tree, and current `master` again before allowing tag/image publication. A concurrent
base change in that small window stops publication even if GitHub already merged the PR; inspect the failed run before
starting recovery. No direct push or ruleset bypass is used to merge `master`.
**Publish prepared release** verifies that the exact candidate is now an ancestor of `master`, creates or verifies its
annotated tag, and calls the reusable GHCR image workflow with `publish_latest: true`. It is called directly rather
than relying on
token-generated push or PR events, whose workflow behavior is restricted by
[GitHub's `GITHUB_TOKEN` rules](https://docs.github.com/en/actions/concepts/security/github_token).
The selected server deploys through the existing WireGuard webhook and must report successful application health before client publication. Native builds queue the exact phone AAB with EAS Submit. Once that ID is verified, OTA can proceed independently of submission monitoring. Phone completion precedes Wear submission. Both OTA exports resolve Expo fingerprint runtimes and isolated publishers use those exact recorded values. Production retains its later approval before environment resolution, export and publication. No signed native tag or Play acceptance gates OTA. Standalone OTA remains client-only; ensure server compatibility separately when using it.

Deployment pulls the image configured in the existing Compose stack (`latest`) and upgrades only `app`. It does not
write image overrides or require deployment state, a lock, or a backup marker. The first integrated cut establishes the native baseline as part of the same orchestration.

Expo's automatic check and download lifecycle remains unchanged. Compatibility is evaluated only after a bundle is
running: native startup uses the Fetch `cache: 'no-store'` request described above to compare its bundled expected
server contract version before restoring the saved session or synchronizing. An incompatible update can therefore
download and start before the runtime gate blocks normal authenticated use. Protected production approval is the
public-channel promotion control after internal publication. End-to-end releases additionally require successful
server deployment before either channel when server/web is selected. The deployment job
checks only its configured target; independent self-hosts still require the runtime guard and are not polled by CI.

The preparation command is also available for isolated release tooling tests:

```powershell
npm.cmd run release:prepare -- --bump patch
```

It updates `shared/release.json`, root/backend package manifests and lockfiles, the two-version web diagnostics
window, the OpenAPI enum, and its generated TypeScript union as one validated batch. Do not run it in an ordinary
feature worktree and commit the result manually.

Recovery is deliberately state-specific:

- Before merge, rerun failed validation jobs in the original run while master and candidate remain unchanged. A validated candidate is retained; master drift requires explicit reconciliation.
- After merge, use **Publish prepared release** with the durable `release_id` to resume retained artifacts and submission IDs. Successful stages remain skipped and ambiguous remote calls require reconciliation first. Historical server image recovery still accepts the exact commit and branch.
- **Build Release Image** remains available for an image-only rebuild. Moving `latest` is allowed only for the highest
  stable tag; use **Publish prepared release** when the ordered image and OTA stages must also resume.

The reusable image workflow still prevents rebuilding an older tag from executing historical deployment jobs. The
version and source-SHA image identities are write-once. Only a registry config digest with the exact verified receipt
attestation is authoritative: recovery fills a missing alias only from that attested manifest, fails if immutable
identities disagree, and never adopts an unattested pre-existing digest. A fresh publication also proves the pushed
config digest equals the credential-free build identity. Moving `latest` is created only from that verified immutable
digest. Validated releases publish version, source-SHA, and moving `latest` tags to GHCR. The release owner configures
one existing Compose stack for [deployment over WireGuard](../deploy/self-hosted/README.md). Other installations can
continue deploying manually. **Deploy self-hosted server** retries the normal `latest` upgrade without rebuilding
or publishing OTA. Each integrated cut creates a durable GitHub Release record; no application version is allocated for an OTA-only cut.

**Cut release** owns exact-candidate metadata validation plus the production container build and startup smoke.
Affected pull-request and scheduled workflows own the broader test, production-image, and migration gates. Package
dependency audits run weekly or manually, independently of pull requests and releases. The local
`release:check:container` and `release:check:production` commands cover the encrypted backup/restore smoke, canonical
version checks, and the static release-acceptance policy without package-advisory gates.
Physical Android/Wear, store-console, and distributed-upgrade checks remain available when the owner considers them
useful for a native distribution, but do not block publishing an independent server/web image.

Native patch versions are prepared automatically with selected server version changes in one release PR. Globally
unique odd/even codes remain consumed after abandonment. Manual local preparation remains available through
node scripts/release-config.mjs prepare-native --bump patch; it does not create a protected native release baseline.
The new [durable release record](native-store-release.md#durable-records-and-recovery) owns CI recovery and artifact identity.

## Reproducible artifact metadata

Generate metadata from the exact release commit. Set `SOURCE_DATE_EPOCH` to the commit timestamp so repeated runs over
the same commit and artifacts produce the same timestamp. Write the result outside the repository so creating the
file does not itself make the recorded worktree dirty.

```powershell
$env:SOURCE_DATE_EPOCH = git show -s --format=%ct HEAD
npm.cmd run release:metadata -- --channel internal `
  --artifact phone=mobile\calibrate-internal.apk `
  --artifact wear=wear\app\build\outputs\apk\internal\app-internal.apk `
  > ..\calibrate-internal-release.json
```

The JSON records the channel, Git commit and dirty state, canonical server/client versions, application ID, artifact
file names, byte counts, and SHA-256 digests. Keep it with the artifacts and release notes; it intentionally contains
no credentials, machine-specific absolute paths, or wall-clock timestamp.

## Native distribution review

Use the applicable items below when distributing phone or Wear artifacts. This is an owner review checklist, not a
standing server/web CI or release gate.

- [ ] `npm run release:check` and `npm run test:release` pass on the release commit.
- [ ] The worktree is clean and the metadata reports the expected Git commit.
- [ ] Every distributed Android artifact has a higher `version_code` than its predecessor.
- [ ] Phone and Wear application IDs and signing certificate fingerprints match.
- [ ] Server API support and mobile/Wear minimum versions match the intended rollout order.
- [ ] Upgrade tests preserve login, local database state, queued mutations, and watch pairing.
- [ ] Phone and Wear smoke tests cover food, weight, activity, disconnect/reconnect, and offline recovery.
- [ ] Artifact SHA-256 values match the generated metadata after transfer.
- [ ] Release notes identify any raised minimum version, migration requirement, or known rollback constraint.
