# Validation policy and diagnostic manifests

The repository uses a **single-user pre-release** policy: path-targeted checks protect
affected code, and the owner chooses additional confidence work for a distribution.
`release-acceptance-plan.json` describes capabilities and workflow/job references,
not outcomes or permission to launch. `npm run release:acceptance` validates it.
There is no evidence-only commit, receipt ledger or extra external-launch gate.

## Automated and optional checks

`npm test` covers backend, API client and Expo tests; `npm run lint` runs zero-warning
ESLint, Kotlin documentation lint, and all TypeScript surfaces. Kotlin lint uses Java 17+
and the isolated [Detekt tool](../tools/kotlin-lint/README.md). `npm run test:lint`
tests the ESLint enforcement.
`npm run test:coverage` gathers c8/Jest diagnostics. Global line coverage is not a
release target; generated bridges and callbacks make it an incomplete risk signal.

PR workflows select affected builds/tests, production-image smoke/OS scanning and
database upgrades. Migration changes additionally select rollback rehearsal. The shared Release workflow owns publication validation as described in
[workflows](../.github/workflows/README.md). Dependency audits and full image library
scans are scheduled/manual maintenance, not package advisory gates on ordinary PRs.

Manual Builds scopes `web`, `native`, `web-and-native`, or `configuration-only` expose
full browser/data-state/UX, Android/Wear emulator and optional same-signer upgrade
diagnostics. An upgrade baseline must be an exact full lowercase source SHA. Artifacts
are short-lived diagnostics, not release receipts. Performance timing is local/field diagnostic work, not a shared-runner release signal.

`risk-evidence.json` maps concrete tests and commands to six areas: auth/isolation,
offline reconciliation, schema/portability, domain math, sensitive diagnostics/config,
and critical client flows. `npm run test:risk-evidence` validates references and gaps;
it does not rerun those suites. Changes in these areas should update focused tests.
Device, store, legal, alert transport and rollout checks remain owner-selected.
Do not equate browser, emulator, physical-device, signed-artifact and deployment evidence.

## Optional physical phone and watch protocol

This is an execution protocol, not a claim that any device passed. Use a clean pushed
source commit, synthetic account, canonical phone/Wear artifacts and one permanent
signer. Capture explicit transient physical Samsung handset/watch ADB targets; never
retain serials, personal/health data, credentials, absolute paths, raw adb/logcat or
private Console links. A changed source makes earlier evidence historical.

Obtain the exact paired artifacts and provenance from the protected build, then use
`node scripts/native-release-devices.mjs --skip-build --candidate <full-sha> --phone-serial <target> --watch-serial <target> --evidence-observation <external-file>`.
Evidence mode requires `BUNDLETOOL_JAR`, exact source/manifest/provenance/hash matches,
physical handset/watch class, lower same-signer installed versions, and `adb install -r`.
Do not uninstall, clear data, downgrade, or replace an incompatible signer to claim an
in-place upgrade. The [native guide](../scripts/README.md#versions-artifacts-and-installation)
owns artifact paths and setup.

Exercise these checkpoint groups against the exact candidate:

- Phone: authentication/restart, onboarding, Today, food create/edit/delete/undo/copy,
  barcode, weight/trend, notification routing/dedupe, Health Connect partial
  permissions/reconnect, session revocation, deletion cleanup and in-place upgrade.
- Phone isolation: offline write, force-stop, reconnect and two relaunches yield one
  mutation; old queued work cannot cross accounts or servers.
- Watch: exact-node/account/server pairing, snapshot/quick actions, allowed phone/legal
  handoffs, session revoke/delete cleanup and same-signer upgrade. Also inspect Tile,
  rotary/round-screen reachability, stale/ambient states and reminder dedupe.
- Watch recovery: queue with both transports absent, restart/reconnect and verify one
  mutation plus bounded refresh in the same account/server scope.

For an optional finalized result, use the exact checkpoint IDs/capability enums exported
by `scripts/native-release-evidence.mjs`. Records contain only `commandId`, `capabilityId`
and boolean `outcome`; do not mark unperformed checks true. Physical command IDs use
`protocol-<checkpoint-key>`; gate IDs map to the named repository commands. OTA success
requires actual publication/download/reopen, not just dry-run. Hosted/disposable emulator
results cannot stand in for physical checks.

`node scripts/native-release-evidence.mjs finalize --observation <external-file> --checkpoints <external-file> --output <external-result> --owner <handle> --executed-on YYYY-MM-DD --synthetic-account`
derives capabilities only from complete valid records. `verify --result <file> --candidate <full-sha>`
checks the result. Keep point-in-time results outside Git. If updating a machine-consumed
risk diagnostic, retain only sanitized evidence allowed by its schema and replace a gap
only when every claimed capability is supported. Such evidence is never release authority.

## Baselines

`performance-budgets.json` pins comparable runtime identities, reviewed references and
budgets; [scripts](../scripts/README.md#operations) owns measurement/update commands.
Reviewed Playwright golden images live beside their tests. Generated reports and ad hoc
screenshots go to ignored output or the PR, not a documentation archive.
