# Shared Expo release pipeline

The root `@mchartier/expo-release` Git dependency and reusable-workflow callers pin one full upstream SHA. `npm run release -- validate` checks the pins and mapped metadata. Upgrade the package, lockfile and callers together after reviewing the toolkit changes.

Calibrate owns `release.config.json`, `scripts/release-hooks.mjs`, input classification and metadata transformations, its command Android builder, compiled artifact assertions and device tooling. The package owns planning, version reservations, protected candidate handling, provider operations, retention, ledger, recovery, deployment transport and workflow phases. Run `npm run release -- setup` to install the official locked EAS toolchain into the shared external cache. See [fresh-history cutover](release-cutover.md).

Generic behavior tests live [upstream](https://github.com/MChartier/expo-release-template). Consumer tests cover configuration and application hooks alongside existing native/application checks. See [protected releases](native-store-release.md), [local commands](mobile-release.md), and the migration ownership report for the measured baseline and remaining responsibilities.
