# CI and release workflows

YAML and the corresponding workers under `scripts/` own inputs, permissions and
job selection. [Quality](../../quality/README.md) owns validation policy. Required
lint/type/test checks report results on every PR, including README-only changes.
Ordinary feature PRs leave canonical release versions unchanged.

## Cut release

Run **Cut release** from protected `master`. Selection compares separate successful
server, native, internal-OTA and production-OTA sources; its summary explains which
changes select each component. Phone native compatibility uses Expo fingerprints;
Wear uses tracked build inputs. Documentation, tests and version bookkeeping do not
select publication. Native diagnostic identity remains a server dependency.

The bump input applies only to a selected server/web release. Native changes reserve
a paired patch version, reusing a valid higher reservation. Phone codes are odd,
Wear codes even, and both must exceed every previously uploaded code. Confirm Play
Console has no unrelated pending changes and coordinate other Console/API writers.
The Console acknowledgement is enforced when native submission is selected.

Preparation creates one protected version-only PR for selected version changes.
Read-only jobs validate the exact candidate, metadata, image startup and required CI.
Finalization verifies trusted run/source/candidate identity and attaches the required
lint, typecheck and test results with evidence links. Only finalization has Checks
write. It rechecks refs, merges through the SHA-bound PR API under branch protection,
then verifies merged ancestry/tree. No direct master push is permitted. A client-only
cut without version changes uses its protected source; a no-op creates nothing.

Before merge, repair failed validation and rerun failed jobs in the original cut
while candidate and master remain unchanged. If master advances, reconcile the
retained candidate first. Do not recut, overwrite, rebase or manually merge it.

## Native store releases

The protected sequence is:

1. Publish any selected server image and build/verify selected phone/Wear packages.
   Retain all four APK/AAB files, hashes, metadata and GitHub attestation.
2. For selected server changes, deploy `latest` through the existing WireGuard
   webhook and require completed application health. Unselected servers receive no call.
3. Queue the exact phone AAB through locked EAS Submit with profile `phone`, track
   `internal`; capture and verify submission ID, project, Android platform and track.
4. Publish applicable internal OTA, then require the existing `production` reviewer
   approval before production environment resolution, export and publication.
5. Independently monitor phone submission. After success, submit and monitor the
   retained Wear AAB with profile `wear`, track `wear:internal`.

A native build failure or unconfirmed initial phone enqueue blocks OTA. Later Play
processing, review or production acceptance does not gate OTA; later submission
failure still fails the release. Artifact and OTA runtime identities must match.
The Android build compares clean managed, built-APK and post-build fingerprints;
generated Kotlin compiler-session caches are excluded, while plugin and Gradle
integrity inputs remain included. Never target a mutable latest EAS build.

All CI Play writers share one non-cancelling concurrency group. **Native Android
Store Release** takes a durable `release_id` and promotes only a pair whose two EAS
submissions succeeded and whose retained attestation, AAB hashes and Play codes verify.

| Operation | Destination |
| --- | --- |
| `promote-closed` | `closed` and `wear:closed` |
| `promote-production` | `production` and `wear:production`, with separate protected credentials |

The pair is never rebuilt for promotion. Local uploads do not establish CI provenance;
local commands and onboarding belong to [scripts](../../scripts/README.md#local-native-workflow).

## Credential boundaries

Use the linked Expo project and Android package configured by the repository.
Keep `EXPO_TOKEN`, `preview` and reviewer-protected `production`. The token has
account/project authority; approval controls sequencing rather than limiting its
channel permissions. Both EAS environments must declare their intended project,
origin and channel. Native store artifacts use the production channel.

Master-only `native-release-signing` retains its reviewer and
`CALIBRATE_ANDROID_UPLOAD_KEYSTORE_BASE64`, `CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD`,
`CALIBRATE_ANDROID_SIGNING_KEY_ALIAS`, and `CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD`.
Build credentials enter only after credential-free prebuild and source checks.

Master-only `play-internal` uses the app's assigned EAS Play submission credential.
The main release does not read a Play JSON key from GitHub. Promotion uses separate
testing and production credentials: `GOOGLE_PLAY_TEST_SERVICE_ACCOUNT_JSON_BASE64`
or `GOOGLE_PLAY_TEST_ACCESS_TOKEN`, and their `GOOGLE_PLAY_PRODUCTION_*` equivalents
in reviewer-protected `play-production`. Prefer app-scoped testing-only authority.
New native releases require no private native tag-signing key or tag-push App.

Application source verification and OTA export stay read-only and receive no Expo
token. Isolated publishers receive inert exported files and their recorded runtime,
so they cannot recompute a fingerprint from a minimal workspace. Draft release
inspection needs push access; isolated workflow-pinned checkpoint/recovery jobs use
job-scoped Contents write. [Self-host deployment](../../deploy/self-hosted/README.md)
owns the existing WireGuard/webhook configuration in `self-hosted-testing`.

### GitHub setup and image integrity

Keep Actions PR creation enabled, `master` protection, and repository write access
to the GHCR package. Use job-scoped Contents/PR writes for publication/finalization
and Packages write only for the source-free publisher. A separate Server Release App,
GHCR robot or publication environment is not required. These job boundaries reduce
credential exposure but cannot constrain someone able to edit write-enabled workflows.

The isolated image signer receives Contents read, OIDC write and Attestations write,
attests exact receipt bytes before package authentication, and has no GHCR credential.
The receipt binds repository, image repository, tag, source and linux/amd64 config
digest. Publisher/recovery independently reconstructs it and verifies exact signer,
source and workflow identity with pinned tooling before adopting/filling aliases.
The reusable signer path and top-level caller path differ and must both verify.

An earlier protected-master signer remains trusted automatically only while critical
workflow/verifier blobs are identical, or it is the exact post-hardening parent of
the verified canonical cut commit. Current master can retain reviewed changed signers
with `allow FULL_SHA` or revoke any signer with `revoke FULL_SHA` in
[`release-image-attestation-trusted-workflow-shas`](../release-image-attestation-trusted-workflow-shas).
Revocation wins. Retain needed signers for the full supported recovery window.
Missing/deleted/flooded attestation evidence fails closed despite bounded expanded
lookup. After an owner audit, quarantine/delete blocked aliases and republish fresh
evidence; never adopt registry bytes alone or overwrite conflicting immutable identity.


## Durable records and recovery

Each non-no-op cut owns a draft GitHub Release tagged `release-run-<run-id>`.
Its body binds the protected run, selection, source and previous successful baselines.
Append-only checkpoint assets record preparation, deployment, artifact identities,
submission IDs, OTA groups and outcomes. Release assets retain binaries and attested
exports beyond Actions artifact expiration. Only one unfinished orchestration is allowed.

For post-merge recovery, run **Publish prepared release** on master with `release_id`,
blank legacy commit/branch fields, and `resume`. It reuses original sources, retained
artifacts and IDs, skips successful stages, and allocates no new versions. Interrupted
retention can recover an exact attested named artifact from its recorded run while
that Actions artifact remains available (30 days). A failed build/attestation must
resume its original job; never substitute new bytes for an accepted artifact.

Explicit recovery may retry a recorded failed EAS submission through EAS's supported
retry operation, recording the replacement ID before readback. If retry is unavailable,
abandon and cut a fresh higher pair. Wrong-track failures instead require terminal,
verified `not-published` reconciliation before resuming corrected profiles with the
same retained binaries; retry preserves the old submission configuration.

Interrupted enqueue, OTA publication or deployment may have succeeded remotely.
Inspect provider/service evidence before another call. A timed-out webhook must not
automatically receive a second POST. Use `recovery_operation=reconcile` with the same
release ID and explicit JSON such as:

```json
{"stage":"phone-submit","status":"observed","id":"EXACT-EAS-SUBMISSION-UUID","artifact_hash":"RETAINED-AAB-SHA256","evidence":"Matched the retained artifact and source in provider records.","confirmed":true}
```

Stages are `phone-submit`, `wear-submit`, `ota-internal`, `ota-production`, and
`deploy`. OTA requires the exact group and retained `bundle_integrity`; matching
channel/runtime alone does not establish identical bytes. Deployment uses empty
ID/hash plus evidence of the intended upgrade and `healthy: true`. Only confirmed
absence of publication and any in-flight operation permits `status: "not-published"`
with empty ID/hash. Keep secrets out of evidence. Reconciliation reads the provider
and appends an audited checkpoint; dispatch resume/abandon separately afterward.

Abandon preserves successful stages and burns reserved native codes. Reconcile
unresolved calls first. Before abandoning an unmerged candidate, close its reviewed
PR and remove only its unchanged branch. A merged server candidate must finish its
tag/image stage before abandonment. Historical server recovery still accepts recorded
release commit/branch, verifies/publishes the image and deploys it; it invents no native
baseline. **Build Release Image** remains image-only.

Native/OTA recovery verifies original hosted workflow/source attestations. Retain
reviewed historical revisions in `.github/native-play-attestation-trusted-workflow-shas`
for supported recovery; revocation wins. Missing/conflicting proof fails closed.

## Client-only OTA

**Publish Expo OTA Update** accepts exact protected `source_ref`, message and channels.
It has no server deployment, native-tag input or Play acceptance gate. Fingerprints
route updates only to matching runtimes; appVersion binaries need a new native
installation before receiving fingerprint updates. The uncached runtime server
compatibility guard still protects independently managed self-hosts; CI does not
poll their private origins. See [shared policy](../../shared/README.md#calorie-and-release-policy).
