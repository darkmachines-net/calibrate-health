# Shared release engine

The release engine is maintained in `MChartier/expo-release-template`. This repository
uses the exact source snapshot under `tools/release-engine/`; `release-engine.lock.json`
records its immutable upstream commit and every file hash. Update the engine in the
template first, then use its snapshot sync command to update the lock and vendored files
together. Do not edit the snapshot directly.

Knip models `tools/release-engine/index.mjs` as the vendored library's public entry
and `tools/verify-release-engine.mjs` as the external workflow action's entry. This
preserves the pinned API without suppressing dead-code checks in Calibrate adapters.

`scripts/release-engine.mjs` adapts the engine to Calibrate's manifest and publication
contracts. `scripts/release-engine.config.mjs` owns the app-specific identities. The
shared engine owns component selection, dependency expansion, stage completion,
operation transitions, version-code reservation and retained artifact inventories.

Calibrate keeps these application policies:

- The server image contains the backend and Expo Web. Native version preparation also
  changes shipped server diagnostic metadata and therefore selects the server.
- Phone and Wear are a paired native cohort. Phone codes are odd, Wear codes are even,
  and every new reservation exceeds both published and previously reserved codes. The
  established 11/12 pair is the bootstrap floor, including after failed releases.
- Native preparation advances a patch version independently of the server bump. Its
  resulting phone runtime is published through OTA even when Wear triggered the pair.
- Selected server deployment and health must complete before OTA. Client-only releases
  have no deployment stage.
- A verified phone submission handoff permits OTA to proceed. The phone upload must
  finish before Wear submission begins. Both submissions must complete before the
  paired native baseline advances; later upload failures do not undo successful OTA.
- Internal and production OTA baselines advance independently. Production retains its
  workflow approval and the runtime server compatibility guard remains unchanged.
- Incomplete requests retain their exact source, artifacts, provider IDs and reserved
  codes. An ambiguous remote outcome requires reconciliation evidence before retry.
- Calibrate's existing Play tracks are `internal` and `wear:internal`. Correcting a
  legacy `qa`/`wear:qa` failure requires operator confirmation that no bundle was
  committed and live readback of the exact terminal rejected submission. Recovery
  retains that ID, AAB digest, rejection and corrected destination in the operation
  history before permitting one new enqueue. Provider retry cannot change a track.

The graph distinguishes `phone-handoff` from `phone-submit`. A persisted submission ID
alone does not prove successful readback. Only the verified handoff checkpoint satisfies
OTA's dependency. Completed component baselines require every transitive prerequisite,
so isolated success records cannot stand in for a complete publication history.

New release records seal the original application source, trusted workflow SHA, toolkit
revision, app configuration, selected graph and independent baselines. Recovery verifies
that envelope on every ledger read. The recorded toolkit revision may be older than the
current reviewed toolkit, subject to artifact signer retention/revocation, but the saved
app configuration must match the executing adapter. A changed project or track therefore
blocks recovery until its reviewed configuration is restored. Older schema-1 ledgers
remain readable: their verified successful phone submission or successful OTA publication
supplies the handoff evidence that predates the separate checkpoint. This preserves an
already published OTA if the asynchronous phone upload later fails. A queued legacy ID
still requires provider readback; it cannot satisfy the OTA barrier on its own.

Run the local contract checks without publication credentials:

```sh
node tools/verify-release-engine.mjs
node --test scripts/release-engine.test.mjs tools/release-engine/test/*.test.mjs
```

The vendored toolkit does not replace protected-default-branch request handling,
exact-candidate CI and merge verification, source-free artifact attestations, or the
separate signing, Expo and deployment credential stages. Those repository workflow
boundaries remain required when using shared code.
