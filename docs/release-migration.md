# Shared release migration

This draft consumes `@mchartier/expo-release` and reusable workers at `1303156faa526fc5c51b8863c56a7c25bf00ab3e` ([template PR #2](https://github.com/MChartier/expo-release-template/pull/2)). Little Say #56 consumes the same revision. Generic selection, reservations, candidate handling, providers, artifact retention, journaling, recovery and deployment transport belong upstream. Calibrate retains configuration, source hooks, metadata transformations, its paired Android builder and application artifact assertions.

## Ownership and footprint

The pre-adoption baseline is `2e8def677fff5e4ff486565218ed5d9afcc4498b`. Physical lines include comments and blanks. The shared `scripts/calibrate-footprint.mjs` inventory includes relocated builders, native setup, hooks, tests, application/build configuration and documentation. Mixed CI, root manifests and documentation are counted toward net authored change. Generated lockfiles and copied engine/verifier files are separate; removing copied code does not earn implementation reduction credit.

The owner-approved [84-file cleanup](release-migration-removals.md) is applied. These measured counts include the optional release confidence workflow, now a thin shared caller:

| Surface | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Implementation, configuration and release workflows | 18,565 | 6,325 | 65.9% |
| Release workflow YAML | 5,204 | 71 | 98.6% |
| Authored source, configuration, tests and documentation | 35,851 | 13,897 | 61.2% |
| Generated lockfiles (separate) | 18,986 | 19,923 | +937 lines |

The final authored count includes this report. The installed package replaces the separate EAS installation and vendored engine. Both application-facing version metadata and Calibrate's native builders remain. Internal OTA preserves source-validated publication; production OTA requires exact native compatibility. No application runtime behavior or held release state is intentionally changed.

## Validation and rollout

The shared suite passed locally on Windows and Linux (278 tests each, two distribution tests run separately), plus clean package/Git installation and exact EAS dependency graph checks. Read-only planner comparisons cover eight scenarios over five real Calibrate commits. Held-release fixtures retain original codes 17/18, source, provider IDs and producing-run evidence without performing live recovery.

Calibrate's clean Windows Git installation, 552-package distribution graph, 27 release tests, 120 native/tooling tests, all TypeScript surfaces and both dead-code checks passed. Clean-to-prebuild runtime consistency passed. Compilation in the long managed worktree hit Ninja's Windows path limit; a short disposable checkout is used for final compilation. The production image builds successfully with a clean Linux npm 10 install. Hosted cross-repository checkout and pin verification pass on Windows and Linux; final compilation and full hosted checks are still running.

Review and merge the template before consumer adoption. Releases, deployment, store/OTA publication and resuming the held release remain separate operations. See [release commands](mobile-release.md) and [protected releases](native-store-release.md).
