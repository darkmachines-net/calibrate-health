# ADR 0008: Cut server and web releases explicitly after merge

- Status: Accepted
- Date: 2026-08-22

## Context

The canonical release manifest previously advanced inside feature PRs. Because several changes can be in flight at
once, contributors had to predict merge order to keep versions monotonic. Missed bumps also required follow-up PRs,
while every `master` push started release-specific validation even when no new manifest version existed.

The repository ruleset requires changes to `master` to arrive through pull requests. Server/web releases therefore
need an explicit preparation step that can own the synchronized version commit without bypassing that rule.

## Decision

Ordinary feature and fix PRs leave the stable server version unchanged. After changes land on `master`, an operator
runs **Cut release** and chooses a strict `patch`, `minor`, or `major` increment. The workflow requires the manifest to
match the highest stable tag, prepares all server/web mirrors on `release/vMAJOR.MINOR.PATCH`, and validates that exact
commit. Validation covers candidate identity, synchronized release configuration, the exact generated mirror set, and
a production-image startup and served-Web smoke. Affected pull-request and scheduled workflows own the broader unit,
integration, API/deploy, production-image, and database checks; package audits run separately as scheduled/manual
maintenance. Before merging, the release finalizer verifies the five reusable CI workflows on the exact
candidate in the protected release run: Lint, Tests, Builds, Production Container Scan and Database Upgrade. Generated-mirror build fan-out and
migration-only rollback skips remain intentional; required classifier/configuration/test/scan/upgrade jobs must pass.

The candidate is merged through an action-created version-only PR only when `master` still points to the source commit
selected at dispatch and the complete current CI inventory succeeds. Failed, cancelled, stale, missing and zero-job
results never authorize merge. The finalizer binds successful jobs to the protected run, workflow revision and exact
candidate, then publishes the required lint, typecheck and test checks on that candidate with links to the evidence.
Only finalization receives Checks write permission; validation jobs remain read-only. This lets token-created release
PRs satisfy the same repository merge rules even though they do not trigger PR workflows. It rechecks CI and
PR/master refs immediately before the SHA-locked PR merge API, and verifies merged ancestry/tree afterward.
The required-status-check rules provide a separate administrator-controlled boundary; client polling and the merge
API do not form an atomic CI-and-base transaction. Publishing tags the validated candidate
commit after proving it is an ancestor of `master`, then calls the reusable GHCR workflow directly. A separate
manual/reusable publisher accepts the exact release commit and branch for post-merge recovery. Cut release now selects paired Android builds and each OTA channel in the same orchestration. Native fingerprint
or Wear-input changes select native builds; exact AABs are submitted through EAS, phone first and Wear after phone
submission completes. OTA can start after phone enqueue and matching runtime validation without waiting for Play.
Selected server changes deploy latest through the existing WireGuard webhook and require successful health before
client publication. An unchanged server requires no deployment or health check. Standalone OTA stays client-only.
The originating run owns a durable GitHub Release record for partial recovery. See
[the unified release runbook](../native-store-release.md) for selection, configuration, and recovery.

Expo's automatic check and download lifecycle remains unchanged. Client configuration responds with
`Cache-Control: no-store`; server selection, startup before restoring a saved session or synchronizing, and manual
compatibility recheck also request it with Fetch `cache: 'no-store'`. Once a bundle runs, the phone compares its bundled
expected server contract version with that response. Different majors block in either direction. Within a major, a
client minor may trail the server minor but may not lead it; patch drift remains compatible. This runtime check does
not claim to prevent the update from downloading or starting. Successful deployment and health gate release-driven OTA,
and protected production approval additionally gates public promotion. Deployment checks only the configured target
and does not assert an exact server/OTA version match. Independent installations retain the runtime guard and are
not polled to gate OTA.

## Consequences

- Parallel feature work no longer reserves or guesses release versions.
- A forgotten version bump cannot block a deployment because feature PRs do not own release identity.
- Release validation is bound to one immutable candidate and stays limited to metadata integrity and a cross-cutting
  production smoke.
- Targeted pull-request and scheduled checks remain the source of truth for broader validation.
- `master` drift, including a change racing the final merge, aborts before the protected branch is updated.
- A manifest ahead of the latest tag represents one pending prepared release and blocks another bump until recovered.
- The release PR and tag add explicit provenance without creating a GitHub Release object or generated changelog.
- OTA updates follow explicit release image publication, remain tied to a published native-build tag, and never publish
  merely because `master` advanced. A missing native tag skips OTA without rolling back the independent server/image
  release.
- Protected production approval controls public promotion, while independently managed self-hosts remain protected
  by the runtime directional contract-version guard.

## CI failure and recovery

GitHub may require human approval for the bot-created PR workflows. Open the PR checks and approve the exact runs
when prompted; the release workflow does not approve itself or bypass that policy. If CI blocks or times out, the
validated candidate is retained. Once checks pass, rerun failed release jobs with the same source/head. A changed
master or candidate stops recovery; inspect and explicitly reconcile the retained branch before a fresh cut.
Do not manually merge it, recut a prepared version, or invoke the post-merge publisher for an unmerged candidate.
An unattended approval-free trigger, if desired, requires a separately reviewed authorization decision.

The always-run stage summary separates candidate validation, CI/merge and publication. Follow the nested publisher
summary for the image digest and OTA/deployment outcomes: optional rollout skips are not image failures. After a
successful merge, use Publish prepared release for tag/image recovery; existing immutable tag/digest and attestation
checks remain authoritative and refuse conflicting aliases. Never overwrite a published release to retry it.
