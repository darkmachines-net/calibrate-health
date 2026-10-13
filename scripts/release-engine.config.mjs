/** @file Calibrate-specific release identities and native cohort policy consumed by the shared release engine. */

export const RELEASE_ENGINE_CONFIG = Object.freeze({
  schemaVersion: 1,
  repository: 'MChartier/calibrate-health',
  defaultBranch: 'master',
  manifest: 'shared/release.json',
  nativeRoles: Object.freeze(['phone', 'wear']),
  minimumReservedCode: 12,
  expo: Object.freeze({
    projectId: 'fda8f8c5-e646-47ac-82fb-35003c9cbec7',
    owner: 'calibrate-health',
    slug: 'calibrate-health-app',
    applicationId: 'net.darkmachines.healthtracker',
    tracks: Object.freeze({ phone: 'qa', wear: 'wear:qa' })
  })
});

/** Executable toolkit and adapter blobs whose changes require explicit historical artifact signer retention. */
export const RELEASE_ENGINE_TRUST_FILES = Object.freeze([
  'scripts/release-engine.mjs', 'scripts/release-engine.config.mjs', 'release-engine.lock.json',
  'tools/verify-release-engine.mjs', 'tools/release-engine/index.mjs', 'tools/release-engine/core.mjs',
  'tools/release-engine/selection.mjs', 'tools/release-engine/graph.mjs', 'tools/release-engine/operation.mjs',
  'tools/release-engine/artifacts.mjs', 'tools/release-engine/versions.mjs'
]);
