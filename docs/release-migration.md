# Shared release migration

This draft consumes `@mchartier/expo-release` and reusable workers at `cb56f92f927486c0d4fe233e97f271d8ba958739` ([template PR #2](https://github.com/MChartier/expo-release-template/pull/2)). Little Say #56 consumes the same revision. Generic selection, reservations, candidate handling, providers, artifact retention, journaling, recovery and deployment transport belong upstream. Calibrate retains configuration, source hooks, metadata transformations, its paired Android builder and application artifact assertions.

## Ownership and footprint

The pre-adoption baseline is `2e8def677fff5e4ff486565218ed5d9afcc4498b`. Physical lines include comments and blanks. The shared `scripts/calibrate-footprint.mjs` inventory includes relocated builders, native setup, hooks, tests, application/build configuration and documentation. Mixed CI, root manifests and documentation are counted toward net authored change. Generated lockfiles and copied engine/verifier files are separate; removing copied code does not earn implementation reduction credit.

The owner-approved [84-file cleanup](release-migration-removals.md) is applied. These measured counts include the optional release confidence workflow, now a thin shared caller:

| Surface | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Implementation, configuration and release workflows | 18,565 | 6,329 | 65.9% |
| Release workflow YAML | 5,204 | 71 | 98.6% |
| Authored source, configuration, tests and documentation | 35,851 | 13,928 | 61.1% |
| Generated lockfiles (separate) | 18,986 | 19,923 | +937 lines |

The final authored count includes this report. The build-tool installation fixes in the general development launcher are line-neutral and excluded from dedicated release ownership. The installed package replaces the separate EAS installation and vendored engine. Both application-facing version metadata and Calibrate's native builders remain. Internal OTA preserves source-validated publication; production OTA requires exact native compatibility. No application runtime behavior or held release state is intentionally changed.

## Validation and rollout

The toolkit's Windows/Linux suite includes clean package/Git installation and exact EAS dependency graph checks ([review revision CI](https://github.com/MChartier/expo-release-template/actions/runs/39144167321)). Read-only planner comparisons cover eight scenarios over five real Calibrate commits. Held-release fixtures retain original codes 17/18, source, provider IDs and producing-run evidence without performing live recovery.

Review corrected shared OTA scheduling for second-wave native targets and build-only profiles, original-run verification beyond 100 jobs, audited destination correction, and original local settings/runtime compatibility. Calibrate now compares ordinary inputs by exact Git blob identity: distinct binary bytes must select a release even when UTF-8 decoding would produce the same text. Only explicit version mirrors use normalized text. This correctness change is covered separately from extraction by a binary-change/version-only regression fixture.

Calibrate's clean Windows Git installation, 552-package distribution graph, 28 release tests, 120 native/tooling tests, 28 development-script tests, all TypeScript surfaces and both dead-code checks passed. The production image builds with clean Linux npm 10 installation and passes readiness, Expo web/PWA and backend-boundary smoke with disposable Postgres. Hosted cross-repository checkout and pin verification pass on Windows and Linux. At application commit `fe5ed6c99aadf2567015f8ebae22c4f576f80688`, the shared local CLI built and verified all four phone/Wear APK/AAB files with an ephemeral test key; runtime `d4a9fb1577ec194eb6c1d9ea868a4c78e01a0507` remained consistent across clean source, prebuild and compilation. The local receipt retained exact hashes and an explicit local origin; the test key and disposable short checkout were removed after validation. Short paths avoid Ninja's Windows path limit. Expo's compiled `file:fingerprint` runtime is verified against its embedded asset, with missing or mismatched bytes rejected.

Review and merge the template before consumer adoption. Releases, deployment, store/OTA publication and resuming the held release remain separate operations. See [release commands](mobile-release.md) and [protected releases](native-store-release.md).
