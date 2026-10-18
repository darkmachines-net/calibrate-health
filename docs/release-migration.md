# Shared release migration

This draft consumes `@mchartier/expo-release` and reusable workers at `c101987cb2af9412dd984dbdf0e917916705319e` ([template PR #2](https://github.com/MChartier/expo-release-template/pull/2)). Little Say #56 consumes the same revision. Generic selection, reservations, candidate handling, providers, artifact retention, journaling, recovery and deployment transport belong upstream. Calibrate retains configuration, source hooks, metadata transformations, its paired Android builder and application artifact assertions.

## Ownership and footprint

The pre-adoption baseline is `2e8def677fff5e4ff486565218ed5d9afcc4498b`. Physical lines include comments and blanks. The shared `scripts/calibrate-footprint.mjs` inventory includes relocated builders, native setup, hooks, tests, application/build configuration and documentation. Mixed CI, root manifests and documentation are counted toward net authored change. Generated lockfiles and copied engine/verifier files are separate; removing copied code does not earn implementation reduction credit.

The [84-file cleanup](release-migration-removals.md) remains pending explicit approval after automatic approval review rejected its deletion scope. These are projected acceptance counts, not completed reductions:

| Surface | Before | After listed cleanup | Reduction |
| --- | ---: | ---: | ---: |
| Implementation, configuration and release workflows | 18,362 | 6,206 | 66.2% |
| Release workflow YAML | 5,123 | 58 | 98.9% |
| Authored source, configuration, tests and documentation | 35,648 | 13,781 | 61.3% |
| Generated lockfiles (separate) | 18,986 | 19,917 | +931 lines |

The final authored count includes this report. The installed package replaces the separate EAS installation and vendored engine. Both application-facing version metadata and Calibrate's native builders remain. Internal OTA preserves source-validated publication; production OTA requires exact native compatibility. No application runtime behavior or held release state is intentionally changed.

## Validation and rollout

The shared suite passed locally on Windows and Linux (278 tests each, two distribution tests run separately), plus clean package/Git installation and exact EAS dependency graph checks. Read-only planner comparisons cover eight scenarios over five real Calibrate commits. Held-release fixtures retain original codes 17/18, source, provider IDs and producing-run evidence without performing live recovery.

Calibrate's 27 release and 120 retained native/tooling checks and all TypeScript surfaces passed before the final Git install. Final clean installation, compiled native runtime checks and hosted caller wiring are being validated. Dead-code checks remain blocked by the obsolete files awaiting cleanup. This migration is incomplete until removal, final checks and the actual footprint report pass.

Review and merge the template before consumer adoption. Releases, deployment, store/OTA publication and resuming the held release remain separate operations. See [release commands](mobile-release.md) and [protected releases](native-store-release.md).
