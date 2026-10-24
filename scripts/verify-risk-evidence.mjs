/** @file Validation of optional source- and device-specific risk evidence without turning it into a release gate. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  NATIVE_RELEASE_PROTOCOL,
  validateNativeReleaseEvidence
} from './native-release-evidence.mjs';
import {
  RELEASE_ACCEPTANCE_SCOPES,
  normalizeReleaseAcceptanceScopes
} from './release-acceptance.mjs';

const EXPECTED_RISK_AREAS = Object.freeze({
  'authentication-and-authorization': [
    'success',
    'invalid-or-expired-credential',
    'replay-or-idempotency',
    'revocation',
    'cross-account-denial'
  ],
  'synchronization-and-offline-writes': [
    'durable-retry',
    'duplicate-replay',
    'stale-revision-or-conflict',
    'account-or-server-isolation',
    'reconnect'
  ],
  'database-and-portability': [
    'fresh-migration',
    'supported-upgrade',
    'representative-export',
    'cascade-deletion',
    'encrypted-backup-validation',
    'clean-restore'
  ],
  'tracking-domain-calculations': [
    'unit-conversion',
    'timezone-or-local-day',
    'boundary-values',
    'immutable-snapshot',
    'api-serialization'
  ],
  'privacy-and-diagnostics': [
    'permission-or-config-assertions',
    'log-redaction',
    'metric-redaction',
    'export-redaction',
    'error-redaction',
    'health-detail-minimization'
  ],
  'critical-client-workflows': [
    'web-state-transitions',
    'web-browser-happy-path',
    'web-failure-recovery',
    'android-state-transitions',
    'android-emulator-happy-path',
    'wear-state-transitions',
    'wear-emulator-package-smoke',
    'android-physical-happy-path',
    'android-physical-offline-reconnect',
    'wear-physical-happy-path',
    'wear-physical-offline-reconnect'
  ]
});

const REQUIRED_PHYSICAL_GAP = Object.freeze({
  id: 'physical-galaxy-phone-and-watch-validation',
  riskArea: 'critical-client-workflows',
  status: 'diagnostic',
  owner: 'MChartier',
  trackingIssues: ['#219', '#222', '#303'],
  releaseScopes: ['native'],
  capabilities: [
    'android-physical-happy-path',
    'android-physical-offline-reconnect',
    'wear-physical-happy-path',
    'wear-physical-offline-reconnect'
  ]
});
const PHYSICAL_CAPABILITIES = new Set(REQUIRED_PHYSICAL_GAP.capabilities);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sortedUniqueStrings(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    return null;
  }
  return [...new Set(value)].sort();
}

function sameStrings(actual, expected) {
  const normalized = sortedUniqueStrings(actual);
  return normalized !== null
    && normalized.length === actual.length
    && normalized.join('\n') === [...expected].sort().join('\n');
}

function describeSetMismatch(actual, expected) {
  const actualSet = new Set(Array.isArray(actual) ? actual : []);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((item) => !actualSet.has(item));
  const unexpected = [...actualSet].filter((item) => !expectedSet.has(item));
  const details = [];
  if (missing.length) details.push(`missing ${missing.join(', ')}`);
  if (unexpected.length) details.push(`unexpected ${unexpected.join(', ')}`);
  if (Array.isArray(actual) && new Set(actual).size !== actual.length) details.push('duplicate values');
  return details.join('; ') || 'invalid value';
}

function validateRepositoryPath(relativePath, label, repoRoot, errors, statSync) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    errors.push(`${label} must be a non-empty repository-relative path.`);
    return;
  }

  const normalized = relativePath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (path.isAbsolute(relativePath) || segments.includes('..')) {
    errors.push(`${label} must stay within the repository: ${relativePath}`);
    return;
  }

  const resolvedPath = path.resolve(repoRoot, relativePath);
  const fromRoot = path.relative(repoRoot, resolvedPath);
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    errors.push(`${label} must stay within the repository: ${relativePath}`);
    return;
  }

  try {
    const stat = statSync(resolvedPath);
    if (!stat.isFile() || stat.size === 0) {
      errors.push(`${label} must reference a non-empty file: ${relativePath}`);
    }
  } catch {
    errors.push(`${label} does not exist: ${relativePath}`);
  }
}

function validateDiagnosticGap(gap, errors) {
  const label = `Diagnostic gap ${gap?.id ?? 'unknown'}`;
  if (typeof gap?.riskArea !== 'string' || !(gap.riskArea in EXPECTED_RISK_AREAS)) {
    errors.push(`${label} must reference a known risk area.`);
  }
  if (gap?.status !== 'diagnostic') {
    errors.push(`${label} status must be diagnostic.`);
  }
  if (typeof gap?.owner !== 'string' || !gap.owner.trim()) {
    errors.push(`${label} must name an owner.`);
  }
  if (typeof gap?.reason !== 'string' || !gap.reason.trim()) {
    errors.push(`${label} must explain why evidence is outstanding.`);
  }
  const releaseScopes = normalizeReleaseAcceptanceScopes(gap?.releaseScopes);
  if (releaseScopes === null) {
    errors.push(
      `${label} releaseScopes must contain unique supported scopes: ` +
      `${RELEASE_ACCEPTANCE_SCOPES.join(', ')}.`
    );
  } else if (JSON.stringify(gap.releaseScopes) !== JSON.stringify(releaseScopes)) {
    errors.push(
      `${label} releaseScopes must use canonical scope order: ` +
      `${RELEASE_ACCEPTANCE_SCOPES.join(', ')}.`
    );
  }

  const trackingIssues = sortedUniqueStrings(gap?.trackingIssues);
  if (
    trackingIssues === null ||
    trackingIssues.length === 0 ||
    trackingIssues.length !== gap.trackingIssues.length ||
    trackingIssues.some((issue) => !/^#\d+$/.test(issue))
  ) {
    errors.push(`${label} trackingIssues must contain unique GitHub issue references such as #222.`);
  }

  const expectedCapabilities = EXPECTED_RISK_AREAS[gap?.riskArea] ?? [];
  const capabilities = sortedUniqueStrings(gap?.capabilities);
  if (
    capabilities === null ||
    capabilities.length === 0 ||
    capabilities.length !== gap.capabilities.length
  ) {
    errors.push(`${label} capabilities must be unique non-empty strings.`);
  } else {
    for (const capability of capabilities) {
      if (!expectedCapabilities.includes(capability)) {
        errors.push(`${label} references unknown capability for ${gap.riskArea}: ${capability}.`);
      }
    }
  }

  if (gap?.id === REQUIRED_PHYSICAL_GAP.id) {
    for (const field of ['riskArea', 'status', 'owner']) {
      if (gap[field] !== REQUIRED_PHYSICAL_GAP[field]) {
        errors.push(
          `${label} ${field} must be ${REQUIRED_PHYSICAL_GAP[field]}, got ${gap[field] ?? 'missing'}.`
        );
      }
    }
    if (!sameStrings(gap.trackingIssues, REQUIRED_PHYSICAL_GAP.trackingIssues)) {
      errors.push(
        `${label} trackingIssues is invalid: ${describeSetMismatch(gap.trackingIssues, REQUIRED_PHYSICAL_GAP.trackingIssues)}.`
      );
    }
    if (!sameStrings(gap.releaseScopes, REQUIRED_PHYSICAL_GAP.releaseScopes)) {
      errors.push(
        `${label} releaseScopes must be native-only.`
      );
    }
  }
}

/** Optional physical results remain useful as device- and source-specific diagnostics. */
function validatePhysicalDeviceEvidence(records, options) {
  const {
    repoRoot,
    now,
    errors,
    statSync,
    readFileSync
  } = options;
  const coveredByArea = new Map();
  const ids = new Set();
  const recordFields = [
    'id',
    'riskArea',
    'status',
    'owner',
    'executedOn',
    'sourceCommit',
    'protocolPath',
    'resultArtifact',
    'capabilities'
  ];

  let manifestContent;
  if (records.length > 0) {
    try {
      manifestContent = readFileSync(path.resolve(repoRoot, 'shared/release.json'));
    } catch (error) {
      errors.push(
        `Unable to read candidate shared/release.json: ${error instanceof Error ? error.message : error}.`
      );
    }
  }

  for (const record of records) {
    const label = `Physical evidence ${record?.id ?? 'unknown'}`;
    if (typeof record?.id !== 'string' || !record.id) {
      errors.push('Every physical device evidence record must have an id.');
      continue;
    }
    if (ids.has(record.id)) errors.push(`Duplicate physical device evidence id: ${record.id}.`);
    ids.add(record.id);

    const actualFields = Object.keys(record).sort();
    const missingFields = recordFields.filter((field) => !actualFields.includes(field));
    const unexpectedFields = actualFields.filter((field) => !recordFields.includes(field));
    if (missingFields.length) errors.push(`${label} is missing fields: ${missingFields.join(', ')}.`);
    if (unexpectedFields.length) errors.push(`${label} has unexpected fields: ${unexpectedFields.join(', ')}.`);

    if (record.riskArea !== REQUIRED_PHYSICAL_GAP.riskArea) {
      errors.push(`${label} must belong to ${REQUIRED_PHYSICAL_GAP.riskArea}.`);
    }
    if (record.status !== 'passed') errors.push(`${label} status must be passed.`);
    if (typeof record.owner !== 'string' || !record.owner.trim()) errors.push(`${label} must name an owner.`);
    if (!/^[0-9a-f]{40}$/.test(record.sourceCommit ?? '')) {
      errors.push(`${label} must record the frozen 40-character source commit.`);
    }

    const executedAt = Date.parse(`${record.executedOn}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.executedOn ?? '') || Number.isNaN(executedAt)) {
      errors.push(`${label} must record a valid YYYY-MM-DD execution date.`);
    } else if (executedAt > now.getTime()) {
      errors.push(`${label} execution date cannot be in the future.`);
    }
    if (record.protocolPath !== NATIVE_RELEASE_PROTOCOL) {
      errors.push(`${label} protocolPath must be ${NATIVE_RELEASE_PROTOCOL}.`);
    }

    const capabilities = sortedUniqueStrings(record.capabilities);
    if (capabilities === null || capabilities.length === 0 || capabilities.length !== record.capabilities.length) {
      errors.push(`${label} capabilities must be unique non-empty strings.`);
    } else {
      const covered = coveredByArea.get(record.riskArea) ?? new Set();
      for (const capability of capabilities) {
        if (!PHYSICAL_CAPABILITIES.has(capability)) {
          errors.push(`${label} references a non-physical or unknown capability: ${capability}.`);
        } else if (covered.has(capability)) {
          errors.push(`${label} duplicates physical capability evidence: ${capability}.`);
        } else {
          covered.add(capability);
        }
      }
      coveredByArea.set(record.riskArea, covered);
    }

    validateRepositoryPath(record.protocolPath, `${label} protocol`, repoRoot, errors, statSync);
    validateRepositoryPath(record.resultArtifact, `${label} result artifact`, repoRoot, errors, statSync);
    try {
      const artifact = JSON.parse(readFileSync(path.resolve(repoRoot, record.resultArtifact), 'utf8'));
      const validation = validateNativeReleaseEvidence(artifact, {
        candidateCommit: record.sourceCommit,
        manifestContent,
        now
      });
      for (const error of validation.errors) errors.push(`${label}: ${error}`);
      for (const field of ['status', 'owner', 'executedOn', 'sourceCommit']) {
        if (artifact[field] !== record[field]) errors.push(`${label} result artifact does not match ${field}.`);
      }
      if (artifact.protocol !== record.protocolPath) {
        errors.push(`${label} result artifact does not match protocolPath.`);
      }
      if (!sameStrings(artifact.capabilities, record.capabilities ?? [])) {
        errors.push(`${label} result artifact capabilities do not match the manifest.`);
      }
    } catch (error) {
      errors.push(`${label} result artifact must be valid JSON: ${error instanceof Error ? error.message : error}.`);
    }
  }

  return coveredByArea;
}

/** Validates the diagnostic risk inventory without running the referenced suites. */
export function validateRiskEvidence({
  manifest,
  packageScripts,
  repoRoot = repositoryRoot,
  now = new Date(),
  statSync = fs.statSync,
  readFileSync = fs.readFileSync
}) {
  const errors = [];
  const gaps = [];
  const rows = [];

  if (manifest?.schemaVersion !== 1) {
    errors.push(`Unsupported risk evidence schema version: ${manifest?.schemaVersion ?? 'missing'}.`);
  }

  const riskAreas = Array.isArray(manifest?.riskAreas) ? manifest.riskAreas : [];
  const areasById = new Map();
  for (const area of riskAreas) {
    if (typeof area?.id !== 'string' || !area.id) {
      errors.push('Every risk area must have an id.');
      continue;
    }
    if (areasById.has(area.id)) {
      errors.push(`Duplicate risk area id: ${area.id}.`);
      continue;
    }
    areasById.set(area.id, area);
  }

  for (const areaId of areasById.keys()) {
    if (!(areaId in EXPECTED_RISK_AREAS)) errors.push(`Unexpected risk area: ${areaId}.`);
  }

  const diagnosticGaps = Array.isArray(manifest?.diagnosticGaps) ? manifest.diagnosticGaps : [];
  const gapIds = new Set();
  const gapCapabilityOwners = new Map();
  for (const gap of diagnosticGaps) {
    if (typeof gap?.id !== 'string' || !gap.id) {
      errors.push('Every diagnostic gap must have an id.');
      continue;
    }
    if (gapIds.has(gap.id)) errors.push(`Duplicate diagnostic gap id: ${gap.id}.`);
    gapIds.add(gap.id);
    validateDiagnosticGap(gap, errors);
    for (const capability of Array.isArray(gap.capabilities) ? gap.capabilities : []) {
      const key = `${gap.riskArea}/${capability}`;
      if (gapCapabilityOwners.has(key)) {
        errors.push(
          `Capability ${key} is listed by both ${gapCapabilityOwners.get(key)} and ${gap.id}.`
        );
      } else {
        gapCapabilityOwners.set(key, gap.id);
      }
    }
    gaps.push(gap);
  }

  const physicalRecords = Array.isArray(manifest?.physicalDeviceEvidence)
    ? manifest.physicalDeviceEvidence
    : [];
  const physicalEvidenceByArea = validatePhysicalDeviceEvidence(physicalRecords, {
    repoRoot,
    now,
    errors,
    statSync,
    readFileSync
  });

  for (const [areaId, expectedCapabilities] of Object.entries(EXPECTED_RISK_AREAS)) {
    const area = areasById.get(areaId);
    if (!area) {
      errors.push(`Missing risk area: ${areaId}.`);
      continue;
    }
    if (typeof area.title !== 'string' || !area.title.trim()) {
      errors.push(`Risk area ${areaId} must have a title.`);
    }
    if (!sameStrings(area.requiredCapabilities, expectedCapabilities)) {
      errors.push(
        `Risk area ${areaId} requiredCapabilities is invalid: ${describeSetMismatch(area.requiredCapabilities, expectedCapabilities)}.`
      );
    }

    const evidence = Array.isArray(area.evidence) ? area.evidence : [];
    if (evidence.length === 0) errors.push(`Risk area ${areaId} must list automated evidence.`);
    const evidenceIds = new Set();
    const automatedCapabilities = new Set();

    for (const item of evidence) {
      const itemLabel = `Evidence ${areaId}/${item?.id ?? 'unknown'}`;
      if (typeof item?.id !== 'string' || !item.id) {
        errors.push(`Risk area ${areaId} contains evidence without an id.`);
      } else if (evidenceIds.has(item.id)) {
        errors.push(`Duplicate evidence id in ${areaId}: ${item.id}.`);
      } else {
        evidenceIds.add(item.id);
      }

      const hasNpmScript = typeof item?.npmScript === 'string' && item.npmScript.length > 0;
      const hasWorkflow = typeof item?.workflow === 'string' && item.workflow.length > 0;
      if (hasNpmScript === hasWorkflow) {
        errors.push(`${itemLabel} must name exactly one npmScript or workflow.`);
      }
      if (hasNpmScript && typeof packageScripts?.[item.npmScript] !== 'string') {
        errors.push(`${itemLabel} references unknown root npm script: ${item.npmScript}.`);
      }
      if (hasNpmScript) {
        if (typeof item.scriptCommand !== 'string' || !item.scriptCommand.trim()) {
          errors.push(`${itemLabel} must pin the expected npm script command.`);
        } else if (
          typeof packageScripts?.[item.npmScript] === 'string' &&
          packageScripts[item.npmScript].trim().replace(/\s+/g, ' ') !==
            item.scriptCommand.trim().replace(/\s+/g, ' ')
        ) {
          errors.push(`${itemLabel} npm script command changed from: ${item.scriptCommand}.`);
        }
      }
      if (hasWorkflow) {
        validateRepositoryPath(item.workflow, `${itemLabel} workflow`, repoRoot, errors, statSync);
        if (typeof item.workflowContains !== 'string' || !item.workflowContains.trim()) {
          errors.push(`${itemLabel} must name the command expected in its workflow.`);
        } else {
          try {
            const workflowSource = readFileSync(path.resolve(repoRoot, item.workflow), 'utf8');
            if (!workflowSource.includes(item.workflowContains)) {
              errors.push(`${itemLabel} workflow no longer contains: ${item.workflowContains}.`);
            }
          } catch {
            // The missing workflow path is already reported by validateRepositoryPath.
          }
        }
      }

      if (!Array.isArray(item?.paths) || item.paths.length === 0) {
        errors.push(`${itemLabel} must reference at least one evidence file.`);
      } else {
        for (const evidencePath of item.paths) {
          validateRepositoryPath(evidencePath, `${itemLabel} path`, repoRoot, errors, statSync);
        }
      }

      const itemCapabilities = sortedUniqueStrings(item?.capabilities);
      if (itemCapabilities === null || itemCapabilities.length !== item.capabilities.length) {
        errors.push(`${itemLabel} capabilities must be unique non-empty strings.`);
        continue;
      }
      for (const capability of itemCapabilities) {
        if (!expectedCapabilities.includes(capability)) {
          errors.push(`${itemLabel} references unknown capability: ${capability}.`);
        } else if (PHYSICAL_CAPABILITIES.has(capability)) {
          errors.push(`${itemLabel} cannot satisfy physical-device capability ${capability}; use physicalDeviceEvidence.`);
        } else {
          automatedCapabilities.add(capability);
        }
      }
    }

    const physicalCapabilities = physicalEvidenceByArea.get(areaId) ?? new Set();
    const gapCapabilities = new Set(
      diagnosticGaps
        .filter((gap) => gap?.riskArea === areaId)
        .flatMap((gap) => Array.isArray(gap.capabilities) ? gap.capabilities : [])
    );
    for (const capability of gapCapabilities) {
      if (automatedCapabilities.has(capability) || physicalCapabilities.has(capability)) {
        errors.push(`Risk area ${areaId} has both evidence and a diagnostic gap for ${capability}.`);
      }
    }
    for (const capability of expectedCapabilities) {
      if (
        !automatedCapabilities.has(capability) &&
        !physicalCapabilities.has(capability) &&
        !gapCapabilities.has(capability)
      ) {
        errors.push(`Risk area ${areaId} has no evidence or diagnostic gap for ${capability}.`);
      }
    }

    if (areaId === REQUIRED_PHYSICAL_GAP.riskArea) {
      const missingPhysicalCapabilities = REQUIRED_PHYSICAL_GAP.capabilities.filter(
        (capability) => !physicalCapabilities.has(capability)
      );
      const physicalGap = diagnosticGaps.find((gap) => gap?.id === REQUIRED_PHYSICAL_GAP.id);
      if (missingPhysicalCapabilities.length === 0 && physicalGap) {
        errors.push(`Remove ${REQUIRED_PHYSICAL_GAP.id}; physical evidence now covers every capability.`);
      } else if (missingPhysicalCapabilities.length > 0 && !physicalGap) {
        errors.push(`Missing diagnostic gap ${REQUIRED_PHYSICAL_GAP.id}.`);
      } else if (
        physicalGap &&
        !sameStrings(physicalGap.capabilities, missingPhysicalCapabilities)
      ) {
        errors.push(
          `Diagnostic gap ${physicalGap.id} capabilities must match outstanding physical evidence: ` +
          `${describeSetMismatch(physicalGap.capabilities, missingPhysicalCapabilities)}.`
        );
      }
    }

    rows.push({
      id: areaId,
      evidenceCount: evidence.length,
      requiredCount: expectedCapabilities.length,
      automatedCount: automatedCapabilities.size,
      physicalCount: physicalCapabilities.size,
      gapCount: gapCapabilities.size
    });
  }

  return { errors, gaps, rows };
}

/** Loads the executable risk manifest and current package scripts from the selected repository root. */
export function loadRepositoryRiskEvidence(repoRoot = repositoryRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'quality/risk-evidence.json'), 'utf8'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return { manifest, packageScripts: packageJson.scripts ?? {}, repoRoot };
}

/** Rejects command-line overrides so risk verification uses the canonical repository manifest. */
export function parseRiskEvidenceArgs(argv) {
  if (argv.length > 0) throw new Error(`Unknown risk-evidence option: ${argv[0]}`);
  return {};
}

function printResult(result) {
  if (result.errors.length) {
    console.error('Risk evidence contract is invalid:');
    for (const error of result.errors) console.error(`- ${error}`);
    return;
  }

  console.log('Risk evidence contract is valid. Numeric coverage remains diagnostic.');
  console.table(result.rows);
  if (result.gaps.length) {
    console.log('Optional physical coverage is not currently recorded:');
    for (const gap of result.gaps) {
      console.log(
        `- ${gap.id}: ${gap.reason}`
      );
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    parseRiskEvidenceArgs(process.argv.slice(2));
    const input = loadRepositoryRiskEvidence();
    const result = validateRiskEvidence(input);
    printResult(result);
    if (result.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(`[risk-evidence] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
