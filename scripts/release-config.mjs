/** @file Canonical server/native release metadata, synchronized mirror updates, and exact candidate validation. */

import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  parseNativeTagAllowedSigners,
  verifyNativeTagAttestation
} from './native-tag-attestation.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
export const RELEASE_MANIFEST_PATH = path.join(REPOSITORY_ROOT, 'shared', 'release.json');
export const GOOGLE_PLAY_MAX_VERSION_CODE = 2_100_000_000;

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const STABLE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NATIVE_RELEASE_TAG_PATTERN = /^native-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HISTORICAL_NATIVE_RELEASE_TAG_PATTERN = /^(?:native-)?v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NATIVE_TAG_ALLOWED_SIGNERS_REPOSITORY_PATH = '.github/native-release-tag-allowed-signers';
const RELEASE_BUMPS = new Set(['major', 'minor', 'patch']);
const RELEASE_VALIDATION_MODES = new Set(['current', 'historical-prepared']);
export const HISTORICAL_PREPARED_RELEASE_COMMIT = '93ff7474521fd93456027df0729d8797e9c47b54';
const SERVER_RELEASE_FILE_PATHS = Object.freeze({
  manifest: 'shared/release.json',
  diagnostics: 'shared/client-diagnostic-versions.json',
  rootPackage: 'package.json',
  rootLock: 'package-lock.json',
  backendPackage: 'backend/package.json',
  backendLock: 'backend/package-lock.json',
  openApi: 'backend/openapi/v1.yaml',
  generatedApi: 'packages/api-client/src/generated/v1.ts'
});
export const PREPARED_RELEASE_MIRROR_PATHS = Object.freeze(
  Object.values(SERVER_RELEASE_FILE_PATHS).sort()
);
// Immutable releases from before the module migration retain their original tree paths.
const HISTORICAL_SERVER_RELEASE_FILE_PATHS = Object.freeze({
  ...SERVER_RELEASE_FILE_PATHS,
  openApi: 'docs/openapi/v1.yaml'
});

/** Reads the module-owned contract, with a read-only fallback for immutable historical release checkouts. */
async function readReleaseOpenApi(root) {
  const current = await readOptionalFile(path.join(root, SERVER_RELEASE_FILE_PATHS.openApi));
  if (current !== null) return current;
  return readFile(path.join(root, HISTORICAL_SERVER_RELEASE_FILE_PATHS.openApi), 'utf8');
}
const HISTORICAL_PREPARED_RELEASE_MANIFEST = {
  schema_version: 1,
  server: {
    version: '0.35.0',
    api: { current: 'v1', supported: ['v1'], legacy_alias: '/api' }
  },
  android: {
    application_id: 'app.calibratehealth.mobile',
    mobile: {
      version_name: '0.2.6',
      version_code: 8,
      native_release_tag: 'v0.13.2',
      minimum_supported_version: '0.1.0'
    },
    wear: {
      version_name: '0.2.6',
      version_code: 8,
      minimum_supported_version: '0.2.0'
    },
    channels: {
      debug: { wear_build_type: 'debug' },
      internal: { mobile_eas_profile: 'internal', wear_build_type: 'internal' },
      production: { mobile_eas_profile: 'production', wear_build_type: 'release' }
    }
  }
};

/** Read canonical JSON; malformed input must stop release preparation. */
const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

/** Preserve source indentation and newline style when updating version mirrors. */
const formatJson = (value, originalSource) => {
  const newline = originalSource.includes('\r\n') ? '\r\n' : '\n';
  const formatted = `${JSON.stringify(value, null, 2)}\n`;
  return newline === '\r\n' ? formatted.replaceAll('\n', '\r\n') : formatted;
};

/** Reject missing or duplicated release fields instead of editing ambiguous source. */
const replaceExactlyOnce = (source, current, replacement, label) => {
  const firstIndex = source.indexOf(current);
  if (firstIndex < 0) throw new Error(`${label} does not contain the expected current release value.`);
  if (source.indexOf(current, firstIndex + current.length) >= 0) {
    throw new Error(`${label} contains the expected current release value more than once.`);
  }
  return `${source.slice(0, firstIndex)}${replacement}${source.slice(firstIndex + current.length)}`;
};

/** Derive every canonical server/web release mirror from the exact parent bytes. */
export function createServerReleaseReplacements(originals, nextVersion) {
  if (!STABLE_SEMVER_PATTERN.test(nextVersion)) {
    throw new Error(`Invalid next stable release version: ${nextVersion}`);
  }
  for (const key of Object.keys(SERVER_RELEASE_FILE_PATHS)) {
    if (typeof originals?.[key] !== 'string') {
      throw new Error(`Missing canonical release source: ${SERVER_RELEASE_FILE_PATHS[key]}.`);
    }
  }

  const manifest = JSON.parse(originals.manifest);
  const diagnostics = JSON.parse(originals.diagnostics);
  const rootPackage = JSON.parse(originals.rootPackage);
  const rootLock = JSON.parse(originals.rootLock);
  const backendPackage = JSON.parse(originals.backendPackage);
  const backendLock = JSON.parse(originals.backendLock);
  const currentVersion = manifest?.server?.version;
  const previousVersion = diagnostics?.previous_web_release;
  if (!STABLE_SEMVER_PATTERN.test(currentVersion)) {
    throw new Error(`Invalid current stable release version: ${currentVersion}`);
  }

  manifest.server.version = nextVersion;
  diagnostics.previous_web_release = currentVersion;
  diagnostics.supported_versions.web = [nextVersion, currentVersion];
  rootPackage.version = nextVersion;
  rootLock.version = nextVersion;
  rootLock.packages[''].version = nextVersion;
  backendPackage.version = nextVersion;
  backendLock.version = nextVersion;
  backendLock.packages[''].version = nextVersion;

  const openApiCurrent = `- properties: { platform: { const: web }, version: { enum: [${currentVersion}, ${previousVersion}] } }`;
  const openApiNext = `- properties: { platform: { const: web }, version: { enum: [${nextVersion}, ${currentVersion}] } }`;
  const generatedCurrent = `version?: "${currentVersion}" | "${previousVersion}";`;
  const generatedNext = `version?: "${nextVersion}" | "${currentVersion}";`;
  return {
    manifest: formatJson(manifest, originals.manifest),
    diagnostics: formatJson(diagnostics, originals.diagnostics),
    rootPackage: formatJson(rootPackage, originals.rootPackage),
    rootLock: formatJson(rootLock, originals.rootLock),
    backendPackage: formatJson(backendPackage, originals.backendPackage),
    backendLock: formatJson(backendLock, originals.backendLock),
    openApi: replaceExactlyOnce(
      originals.openApi,
      openApiCurrent,
      openApiNext,
      SERVER_RELEASE_FILE_PATHS.openApi
    ),
    generatedApi: replaceExactlyOnce(
      originals.generatedApi,
      generatedCurrent,
      generatedNext,
      SERVER_RELEASE_FILE_PATHS.generatedApi
    )
  };
}

/** Replace one reviewed version field without accepting a changed source layout. */
const replacePatternExactlyOnce = (source, pattern, replacement, label) => {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  const matches = [...source.matchAll(globalPattern)];
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one matching release value; found ${matches.length}.`);
  }
  return source.replace(globalPattern, replacement);
};

/** Distinguish an absent optional mirror from unreadable or invalid source. */
const readOptionalFile = async (filePath) => {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

/** Resolve a manifest field without assuming every optional parent exists. */
const getPath = (value, dottedPath) => dottedPath.split('.').reduce((current, key) => current?.[key], value);

/** Parse numeric and prerelease identifiers without losing integer precision. */
const parseSemver = (value) => {
  const match = value.match(SEMVER_PATTERN);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return {
    core: match.slice(1, 4),
    prerelease: match[4]?.split('.') ?? null
  };
};

/** Compare arbitrary-sized numeric version identifiers. */
const compareNumericIdentifier = (left, right) => {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

/** Order semantic versions while ignoring build metadata. */
export const compareSemver = (left, right) => {
  const leftVersion = parseSemver(left);
  const rightVersion = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = compareNumericIdentifier(leftVersion.core[index], rightVersion.core[index]);
    if (difference !== 0) return difference;
  }

  if (leftVersion.prerelease === null) return rightVersion.prerelease === null ? 0 : 1;
  if (rightVersion.prerelease === null) return -1;
  const identifierCount = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
};

/** Calculate the next strict stable release without losing precision. */
export function nextReleaseVersion(version, bump) {
  if (!STABLE_SEMVER_PATTERN.test(version)) throw new Error(`Invalid stable release version: ${version}`);
  if (!RELEASE_BUMPS.has(bump)) throw new Error('Release bump must be major, minor, or patch.');

  let [major, minor, patch] = version.split('.').map((part) => BigInt(part));
  if (bump === 'major') {
    major += 1n;
    minor = 0n;
    patch = 0n;
  } else if (bump === 'minor') {
    minor += 1n;
    patch = 0n;
  } else {
    patch += 1n;
  }
  return `${major}.${minor}.${patch}`;
}

const CLIENT_DIAGNOSTIC_PLATFORMS = ['web', 'android_phone', 'ios', 'wear_os'];
const MAX_CLIENT_DIAGNOSTIC_VERSIONS_PER_PLATFORM = 16;

// Only the exact pre-iOS recovery identity may use the historical native contract.
/** Allow only the explicitly supported historical mirror layout. */
function isExactHistoricalPreparedRelease(manifest, { validationMode, sourceCommit } = {}) {
  return validationMode === 'historical-prepared'
    && sourceCommit === HISTORICAL_PREPARED_RELEASE_COMMIT
    && isDeepStrictEqual(manifest, HISTORICAL_PREPARED_RELEASE_MANIFEST);
}

/** Select the diagnostic platform set valid for this historical manifest. */
function clientDiagnosticPlatforms(manifest, validationOptions) {
  if (isExactHistoricalPreparedRelease(manifest, validationOptions)) {
    return CLIENT_DIAGNOSTIC_PLATFORMS.filter((platform) => platform !== 'ios');
  }
  return CLIENT_DIAGNOSTIC_PLATFORMS;
}

/** Keep the reviewed rollout window synchronized with current releases and the generated API source. */
export function validateClientDiagnosticVersionContract(manifest, diagnosticVersions, openApiSource, validationOptions = {}) {
  const errors = [];
  const platforms = clientDiagnosticPlatforms(manifest, validationOptions);
  const supported = diagnosticVersions?.supported_versions;
  const previousWebRelease = diagnosticVersions?.previous_web_release;
  if (diagnosticVersions?.schema_version !== 1) {
    errors.push('client-diagnostic-versions.json schema_version must be 1.');
  }
  if (typeof previousWebRelease !== 'string' || !STABLE_SEMVER_PATTERN.test(previousWebRelease)) {
    errors.push('client-diagnostic-versions.json previous_web_release must be a stable semantic version.');
  }
  if (!supported || typeof supported !== 'object' || Array.isArray(supported)) {
    return [...errors, 'client-diagnostic-versions.json supported_versions must be an object.'];
  }

  const keys = Object.keys(supported).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...platforms].sort())) {
    errors.push(`client-diagnostic-versions.json must define exactly ${platforms.join(', ')}.`);
  }
  const currentVersions = {
    web: manifest?.server?.version,
    android_phone: manifest?.android?.mobile?.version_name,
    ios: manifest?.android?.mobile?.version_name,
    wear_os: manifest?.android?.wear?.version_name
  };
  const minimumVersions = {
    android_phone: manifest?.android?.mobile?.minimum_supported_version,
    ios: manifest?.android?.mobile?.minimum_supported_version,
    wear_os: manifest?.android?.wear?.minimum_supported_version
  };

  for (const platform of platforms) {
    const versions = supported[platform];
    if (!Array.isArray(versions) || versions.length === 0 || versions.length > MAX_CLIENT_DIAGNOSTIC_VERSIONS_PER_PLATFORM) {
      errors.push(`client diagnostic ${platform} versions must contain 1-${MAX_CLIENT_DIAGNOSTIC_VERSIONS_PER_PLATFORM} entries.`);
      continue;
    }
    if (versions.some((version) => typeof version !== 'string' || !STABLE_SEMVER_PATTERN.test(version))) {
      errors.push(`client diagnostic ${platform} versions must be stable semantic versions.`);
      continue;
    }
    if (new Set(versions).size !== versions.length) {
      errors.push(`client diagnostic ${platform} versions must be unique.`);
    }
    if (versions[0] !== currentVersions[platform]) {
      errors.push(`client diagnostic ${platform} versions must start with the current release ${currentVersions[platform]}.`);
    }
    if (platform === 'web' && (versions.length !== 2 || versions[1] !== previousWebRelease)) {
      errors.push('client diagnostic web versions must retain exactly the reviewed previous_web_release.');
    }
    const current = currentVersions[platform];
    if (platform === 'web' && typeof previousWebRelease === 'string'
      && STABLE_SEMVER_PATTERN.test(previousWebRelease)
      && typeof current === 'string' && STABLE_SEMVER_PATTERN.test(current)
      && compareSemver(previousWebRelease, current) >= 0) {
      errors.push('client diagnostic previous_web_release must be older than the current server release.');
    }
    const minimum = platform === 'web' ? null : minimumVersions[platform];
    if (typeof current === 'string' && STABLE_SEMVER_PATTERN.test(current)) {
      for (const version of versions) {
        if (compareSemver(version, current) > 0 || (minimum && compareSemver(version, minimum) < 0)) {
          errors.push(`client diagnostic ${platform} version ${version} is outside the supported release range.`);
        }
      }
    }
    const openApiLine = `- properties: { platform: { const: ${platform} }, version: { enum: [${versions.join(', ')}] } }`;
    if (typeof openApiSource !== 'string' || !openApiSource.includes(openApiLine)) {
      errors.push(`OpenAPI client diagnostic ${platform} versions do not match client-diagnostic-versions.json.`);
    }
  }

  return errors;
}

/** Return the production tag encoded by the canonical manifest and ensure it advances. */
export function getReleaseTag(manifest, latestTag = null) {
  const version = manifest?.server?.version;
  if (typeof version !== 'string' || !STABLE_SEMVER_PATTERN.test(version)) {
    throw new Error('Production release tags require a stable server.version in shared/release.json.');
  }
  if (latestTag !== null) {
    if (!/^v\d+\.\d+\.\d+$/.test(latestTag)) throw new Error(`Invalid latest release tag: ${latestTag}`);
    if (compareSemver(version, latestTag.slice(1)) <= 0) {
      throw new Error(`Manifest version ${version} must be newer than ${latestTag}.`);
    }
  }
  return `v${version}`;
}

/** Decide whether the reviewed manifest needs a new stable tag without treating an existing tag as an error. */
export function getReleasePlan(manifest, latestTag = null) {
  const newTag = getReleaseTag(manifest);
  if (latestTag === null) {
    return { latest_tag: '', new_tag: newTag, should_release: true };
  }
  if (!/^v\d+\.\d+\.\d+$/.test(latestTag)) throw new Error(`Invalid latest release tag: ${latestTag}`);

  const comparison = compareSemver(newTag.slice(1), latestTag.slice(1));
  if (comparison < 0) {
    throw new Error(`Manifest version ${newTag.slice(1)} cannot be older than ${latestTag}.`);
  }
  return {
    latest_tag: latestTag,
    new_tag: newTag,
    should_release: comparison > 0
  };
}

/** Validate paired codes, compatibility fields, and canonical release identities. */
export function validateManifest(manifest, { validationMode = 'current', sourceCommit = null } = {}) {
  if (!RELEASE_VALIDATION_MODES.has(validationMode)) {
    throw new Error(`Unknown release validation mode: ${validationMode}`);
  }
  const isHistoricalPreparedManifest = isDeepStrictEqual(manifest, HISTORICAL_PREPARED_RELEASE_MANIFEST);
  const enforceCurrentNativePolicy = !isExactHistoricalPreparedRelease(manifest, { validationMode, sourceCommit });
  const errors = [];
  if (
    validationMode === 'historical-prepared'
    && isHistoricalPreparedManifest
    && sourceCommit !== HISTORICAL_PREPARED_RELEASE_COMMIT
  ) {
    errors.push(
      `Historical prepared release v0.35.0 requires source commit ${HISTORICAL_PREPARED_RELEASE_COMMIT}.`
    );
  }
  const requiredSemvers = [
    'server.version',
    'android.mobile.version_name',
    'android.mobile.minimum_supported_version',
    'android.wear.version_name',
    'android.wear.minimum_supported_version'
  ];

  if (manifest?.schema_version !== 1) errors.push('schema_version must be 1.');
  for (const key of requiredSemvers) {
    const value = getPath(manifest, key);
    if (typeof value !== 'string' || !SEMVER_PATTERN.test(value)) {
      errors.push(`${key} must be a semantic version such as 1.2.3.`);
    }
  }

  for (const client of ['mobile', 'wear']) {
    const versionCode = getPath(manifest, `android.${client}.version_code`);
    if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
      errors.push(`android.${client}.version_code must be a positive integer.`);
    } else if (versionCode > GOOGLE_PLAY_MAX_VERSION_CODE) {
      errors.push(`android.${client}.version_code cannot exceed Google Play's ${GOOGLE_PLAY_MAX_VERSION_CODE} limit.`);
    } else if (enforceCurrentNativePolicy && client === 'mobile' && versionCode % 2 !== 1) {
      errors.push('android.mobile.version_code must be odd so phone and Wear releases remain globally unique in Play.');
    } else if (enforceCurrentNativePolicy && client === 'wear' && versionCode % 2 !== 0) {
      errors.push('android.wear.version_code must be even so phone and Wear releases remain globally unique in Play.');
    }
    const current = getPath(manifest, `android.${client}.version_name`);
    const minimum = getPath(manifest, `android.${client}.minimum_supported_version`);
    if (SEMVER_PATTERN.test(current ?? '') && SEMVER_PATTERN.test(minimum ?? '') && compareSemver(minimum, current) > 0) {
      errors.push(`android.${client}.minimum_supported_version cannot exceed its current version.`);
    }
  }

  const mobileVersionCode = manifest?.android?.mobile?.version_code;
  const wearVersionCode = manifest?.android?.wear?.version_code;
  if (
    enforceCurrentNativePolicy
    && Number.isSafeInteger(mobileVersionCode)
    && mobileVersionCode === wearVersionCode
  ) {
    errors.push('android mobile and Wear version_code values must be globally unique in Play.');
  }

  const nativeReleaseTag = manifest?.android?.mobile?.native_release_tag;
  const mobileVersionName = manifest?.android?.mobile?.version_name;
  if (enforceCurrentNativePolicy) {
    if (typeof nativeReleaseTag !== 'string' || !NATIVE_RELEASE_TAG_PATTERN.test(nativeReleaseTag)) {
      errors.push('android.mobile.native_release_tag must be a stable native-vMAJOR.MINOR.PATCH tag.');
    } else if (
      STABLE_SEMVER_PATTERN.test(mobileVersionName ?? '') &&
      nativeReleaseTag !== `native-v${mobileVersionName}`
    ) {
      errors.push('android.mobile.native_release_tag must match android.mobile.version_name.');
    }
  } else if (
    typeof nativeReleaseTag !== 'string'
    || !HISTORICAL_NATIVE_RELEASE_TAG_PATTERN.test(nativeReleaseTag)
  ) {
    errors.push(
      'android.mobile.native_release_tag must be a stable vMAJOR.MINOR.PATCH or native-vMAJOR.MINOR.PATCH tag.'
    );
  }

  const applicationId = manifest?.android?.application_id;
  if (typeof applicationId !== 'string' || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(applicationId)) {
    errors.push('android.application_id must be a valid lowercase Android application ID.');
  }

  const currentApi = manifest?.server?.api?.current;
  const supportedApis = manifest?.server?.api?.supported;
  if (typeof currentApi !== 'string' || !Array.isArray(supportedApis) || !supportedApis.includes(currentApi)) {
    errors.push('server.api.supported must include server.api.current.');
  }

  const requiredChannels = ['debug', 'internal', 'production'];
  for (const channel of requiredChannels) {
    if (!manifest?.android?.channels?.[channel]) errors.push(`android.channels.${channel} is required.`);
  }

  return errors;
}

/** Accumulate mirror differences for one actionable configuration report. */
const assertMatch = (errors, label, actual, expected) => {
  if (actual !== expected) errors.push(`${label} is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`);
};

/** Read one required source field and report a missing pattern as a validation error. */
const capture = (source, pattern, label, errors) => {
  const match = source.match(pattern);
  if (!match) {
    errors.push(`Could not read ${label}.`);
    return null;
  }
  return match[1];
};

/** Compare every tracked version mirror against the canonical release manifest. */
export async function checkRepository(
  root = REPOSITORY_ROOT,
  { validationMode = 'current', sourceCommit = null } = {}
) {
  const manifest = await readJson(path.join(root, 'shared', 'release.json'));
  const resolvedSourceCommit = validationMode === 'historical-prepared'
    ? sourceCommit ?? tryGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
    : null;
  const validationOptions = { validationMode, sourceCommit: resolvedSourceCommit };
  const errors = validateManifest(manifest, validationOptions);
  const [
    rootPackage,
    rootPackageLock,
    backendPackage,
    backendPackageLock,
    mobilePackage,
    pairingPackage,
    expoConfig,
    easConfig,
    mobileGradle,
    wearGradle,
    pairingGradle,
    diagnosticVersions,
    openApiSource,
    generatedApiClientSource
  ] = await Promise.all([
    readJson(path.join(root, 'package.json')),
    readJson(path.join(root, 'package-lock.json')),
    readJson(path.join(root, 'backend', 'package.json')),
    readJson(path.join(root, 'backend', 'package-lock.json')),
    readJson(path.join(root, 'mobile', 'package.json')),
    readJson(path.join(root, 'mobile', 'modules', 'wear-pairing', 'package.json')),
    readJson(path.join(root, 'mobile', 'app.json')),
    readJson(path.join(root, 'mobile', 'eas.json')),
    readOptionalFile(path.join(root, 'mobile', 'android', 'app', 'build.gradle')),
    readFile(path.join(root, 'wear', 'app', 'build.gradle.kts'), 'utf8'),
    readFile(path.join(root, 'mobile', 'modules', 'wear-pairing', 'android', 'build.gradle'), 'utf8'),
    readJson(path.join(root, 'shared', 'client-diagnostic-versions.json')),
    readReleaseOpenApi(root),
    readFile(path.join(root, 'packages', 'api-client', 'src', 'generated', 'v1.ts'), 'utf8')
  ]);
  errors.push(...validateClientDiagnosticVersionContract(manifest, diagnosticVersions, openApiSource, validationOptions));

  assertMatch(errors, 'package.json version', rootPackage.version, manifest.server.version);
  assertMatch(errors, 'package-lock.json version', rootPackageLock.version, manifest.server.version);
  assertMatch(errors, 'package-lock.json root package version', rootPackageLock.packages?.['']?.version, manifest.server.version);
  assertMatch(errors, 'backend/package.json version', backendPackage.version, manifest.server.version);
  assertMatch(errors, 'backend/package-lock.json version', backendPackageLock.version, manifest.server.version);
  assertMatch(
    errors,
    'backend/package-lock.json root package version',
    backendPackageLock.packages?.['']?.version,
    manifest.server.version
  );
  assertMatch(errors, 'mobile/package.json version', mobilePackage.version, manifest.android.mobile.version_name);
  assertMatch(
    errors,
    'package-lock.json mobile workspace version',
    rootPackageLock.packages?.mobile?.version,
    manifest.android.mobile.version_name
  );
  assertMatch(
    errors,
    'Wear pairing package version',
    pairingPackage.version,
    manifest.android.mobile.version_name
  );
  assertMatch(
    errors,
    'package-lock.json Wear pairing workspace version',
    rootPackageLock.packages?.['mobile/modules/wear-pairing']?.version,
    manifest.android.mobile.version_name
  );
  assertMatch(errors, 'mobile/app.json expo.version', expoConfig.expo?.version, manifest.android.mobile.version_name);
  assertMatch(errors, 'mobile/app.json expo.android.versionCode', expoConfig.expo?.android?.versionCode, manifest.android.mobile.version_code);
  // Both platforms share the mobile counter; the exact pre-iOS recovery source has no iOS block.
  if (!isExactHistoricalPreparedRelease(manifest, validationOptions) || expoConfig.expo?.ios) {
    assertMatch(
      errors,
      'mobile/app.json expo.ios.buildNumber',
      expoConfig.expo?.ios?.buildNumber,
      String(manifest.android.mobile.version_code)
    );
  }
  assertMatch(errors, 'mobile/app.json expo.android.package', expoConfig.expo?.android?.package, manifest.android.application_id);
  assertMatch(
    errors,
    'mobile/app.json expo.extra.calibrate.nativeReleaseTag',
    expoConfig.expo?.extra?.calibrate?.nativeReleaseTag,
    manifest.android.mobile.native_release_tag
  );

  // Expo generates this ignored directory. Validate it when present without making a clean checkout depend on prebuild.
  if (mobileGradle !== null) {
    const mobileVersionCode = Number(capture(mobileGradle, /versionCode\s+(\d+)/, 'mobile native versionCode', errors));
    const mobileVersionName = capture(mobileGradle, /versionName\s+["']([^"']+)["']/, 'mobile native versionName', errors);
    const mobileApplicationId = capture(mobileGradle, /applicationId\s+["']([^"']+)["']/, 'mobile native applicationId', errors);
    assertMatch(errors, 'mobile native versionCode', mobileVersionCode, manifest.android.mobile.version_code);
    assertMatch(errors, 'mobile native versionName', mobileVersionName, manifest.android.mobile.version_name);
    assertMatch(errors, 'mobile native applicationId', mobileApplicationId, manifest.android.application_id);
  }

  const wearVersionCode = Number(capture(wearGradle, /versionCode\s*=\s*(\d+)/, 'Wear versionCode', errors));
  const wearVersionName = capture(wearGradle, /versionName\s*=\s*"([^"]+)"/, 'Wear versionName', errors);
  const wearApplicationId = capture(wearGradle, /applicationId\s*=\s*"([^"]+)"/, 'Wear applicationId', errors);
  assertMatch(errors, 'Wear versionCode', wearVersionCode, manifest.android.wear.version_code);
  assertMatch(errors, 'Wear versionName', wearVersionName, manifest.android.wear.version_name);
  assertMatch(errors, 'Wear applicationId', wearApplicationId, manifest.android.application_id);

  const pairingVersion = capture(pairingGradle, /^version\s*=\s*["']([^"']+)["']/m, 'Wear pairing module version', errors);
  const pairingVersionCode = Number(capture(pairingGradle, /versionCode\s+(\d+)/, 'Wear pairing module versionCode', errors));
  assertMatch(errors, 'Wear pairing module version', pairingVersion, manifest.android.mobile.version_name);
  assertMatch(errors, 'Wear pairing module versionCode', pairingVersionCode, manifest.android.mobile.version_code);

  for (const channel of ['internal', 'production']) {
    const profile = manifest.android.channels[channel].mobile_eas_profile;
    if (!easConfig.build?.[profile]) {
      errors.push(`mobile/eas.json is missing the ${profile} profile for ${channel}.`);
    } else {
      assertMatch(
        errors,
        `mobile/eas.json ${profile} update channel`,
        easConfig.build[profile].channel,
        channel
      );
    }
  }

  for (const diagnosticPlatform of clientDiagnosticPlatforms(manifest, validationOptions)) {
    const versions = diagnosticVersions?.supported_versions?.[diagnosticPlatform];
    if (Array.isArray(versions)) {
      const marker = `platform?: "${diagnosticPlatform}";`;
      const markerIndex = generatedApiClientSource.indexOf(marker);
      const nextMarkerIndex = generatedApiClientSource.indexOf('platform?: "', markerIndex + marker.length);
      const block = markerIndex < 0
        ? ''
        : generatedApiClientSource.slice(markerIndex, nextMarkerIndex < 0 ? undefined : nextMarkerIndex);
      const expectedVersions = `version?: "${versions.join('" | "')}";`;
      if (!block.includes(expectedVersions)) {
        errors.push(
          `Generated API client ${diagnosticPlatform} diagnostic versions do not match client-diagnostic-versions.json.`
        );
      }
    }
  }

  return { manifest, errors };
}

/** Read optional Git metadata with an explicit fallback for unavailable values. */
const gitValue = (root, args, fallback = null) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
};

/** Run exact Git inspection with replacement objects disabled. */
const runGit = (root, args) => execFileSync('git', ['--no-replace-objects', ...args], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
}).trim();

/** Preserve exact file bytes for canonical candidate reconstruction. */
const runGitRaw = (root, args) => execFileSync('git', ['--no-replace-objects', ...args], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});

/** Represent an unavailable Git ref explicitly without weakening later validation. */
const tryGit = (root, args, git = runGit) => {
  try {
    return git(root, args);
  } catch {
    return null;
  }
};

/** Require a full immutable commit identity at the release boundary. */
const requireCommitId = (value, label) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a full lowercase Git commit SHA.`);
  }
  return value;
};

/** Parse a tracked manifest from the specified immutable revision. */
const readGitJson = (root, revision, relativePath, git) => {
  let source;
  try {
    source = git(root, ['show', `${revision}:${relativePath}`]);
  } catch (error) {
    throw new Error(`Unable to read ${relativePath} from ${revision}.`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${relativePath} from ${revision} is not valid JSON.`, { cause: error });
  }
};

/** Bind annotated server tags to their exact direct target and internal name. */
const parseAnnotatedReleaseTag = (source, expectedTag) => {
  const headers = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (line.length === 0) break;
    const match = line.match(/^([^ ]+) (.+)$/);
    if (!match) continue;
    if (headers.has(match[1])) throw new Error(`Annotated release tag has duplicate ${match[1]} headers.`);
    headers.set(match[1], match[2]);
  }
  const target = requireCommitId(headers.get('object'), 'Annotated release tag target');
  if (headers.get('type') !== 'commit') {
    throw new Error(`Annotated release tag ${expectedTag} must point directly to a commit.`);
  }
  if (headers.get('tag') !== expectedTag) {
    throw new Error(
      `Annotated release tag object names ${headers.get('tag') ?? 'no tag'}, not ${expectedTag}.`
    );
  }
  return target;
};

/** Reconstruct the candidate from its parent and reject any unrelated source changes. */
const validatePreparedReleaseCandidate = async ({
  root,
  releaseTag,
  expectedCommit,
  publishLatest,
  candidateParentCurrentMaster,
  git,
  gitRaw,
  checkRepositoryFn,
  masterAlreadyFetched
}) => {
  if (typeof releaseTag !== 'string' || !RELEASE_TAG_PATTERN.test(releaseTag)) {
    throw new Error('Prepared release tag must match vMAJOR.MINOR.PATCH.');
  }
  if (expectedCommit === null) throw new Error('Expected release commit is required.');
  requireCommitId(expectedCommit, 'Expected release commit');
  if (typeof publishLatest !== 'boolean') throw new Error('publishLatest must be a boolean.');
  if (typeof candidateParentCurrentMaster !== 'boolean') {
    throw new Error('candidateParentCurrentMaster must be a boolean.');
  }

  if (!masterAlreadyFetched) {
    try {
      git(root, [
        'fetch',
        '--force',
        '--no-tags',
        'origin',
        '+refs/heads/master:refs/remotes/origin/master'
      ]);
    } catch (error) {
      throw new Error('Unable to fetch origin/master for prepared release verification.', { cause: error });
    }
  }

  const checkoutCommit = requireCommitId(
    git(root, ['rev-parse', '--verify', 'HEAD^{commit}']),
    'Prepared release checkout'
  );
  if (checkoutCommit !== expectedCommit) {
    throw new Error(`Prepared release checkout ${checkoutCommit} does not match expected commit ${expectedCommit}.`);
  }

  const masterCommit = requireCommitId(
    git(root, ['rev-parse', '--verify', 'refs/remotes/origin/master^{commit}']),
    'Fetched origin/master'
  );
  const parentLine = git(root, ['rev-list', '--parents', '-n', '1', checkoutCommit]);
  const parentParts = parentLine.split(/\s+/);
  if (parentParts.length !== 2 || parentParts[0] !== checkoutCommit) {
    throw new Error(`Prepared release commit ${checkoutCommit} must have exactly one parent.`);
  }
  const parentCommit = requireCommitId(parentParts[1], 'Prepared release parent');
  if (candidateParentCurrentMaster) {
    if (parentCommit !== masterCommit) {
      throw new Error(
        `Prepared release parent ${parentCommit} does not match current origin/master ${masterCommit}.`
      );
    }
  } else {
    try {
      git(root, ['merge-base', '--is-ancestor', checkoutCommit, masterCommit]);
    } catch (error) {
      throw new Error(
        `Prepared release commit ${checkoutCommit} is not on current origin/master history.`,
        { cause: error }
      );
    }
  }
  const diffSource = git(root, [
    'diff-tree',
    '--no-commit-id',
    '--name-status',
    '-r',
    '--no-renames',
    parentCommit,
    checkoutCommit
  ]);
  const changedPaths = [];
  for (const line of diffSource.split(/\r?\n/).filter((value) => value.length > 0)) {
    const match = line.match(/^M\t(.+)$/);
    if (!match) {
      throw new Error('Prepared release diff must contain only modifications to canonical release mirrors.');
    }
    changedPaths.push(match[1]);
  }
  changedPaths.sort();
  const releasePaths = changedPaths.includes(HISTORICAL_SERVER_RELEASE_FILE_PATHS.openApi)
    ? HISTORICAL_SERVER_RELEASE_FILE_PATHS
    : SERVER_RELEASE_FILE_PATHS;
  const serverMirrorPaths = Object.values(releasePaths).sort();
  const nativeReleasePaths = { ...NATIVE_RELEASE_FILE_PATHS, openApi: releasePaths.openApi };
  const parentNative = readGitJson(root, parentCommit, 'shared/release.json', git).android.mobile.version_name;
  const candidateNative = readGitJson(root, checkoutCommit, 'shared/release.json', git).android.mobile.version_name;
  const nativeChanged = parentNative !== candidateNative;
  const mirrorPaths = nativeChanged
    ? [...new Set([...serverMirrorPaths, ...Object.values(nativeReleasePaths)])].sort()
    : serverMirrorPaths;
  if (nativeChanged && candidateNative !== nextReleaseVersion(parentNative, 'patch')) {
    throw new Error('An automatic native candidate must advance exactly one patch version.');
  }
  if (!isDeepStrictEqual(changedPaths, mirrorPaths)) {
    throw new Error(
      `Prepared release diff must change exactly: ${mirrorPaths.join(', ')}.`
    );
  }

  const repositoryCheck = await checkRepositoryFn(root, { validationMode: 'historical-prepared' });
  if (!repositoryCheck || !Array.isArray(repositoryCheck.errors) || repositoryCheck.errors.length > 0) {
    const details = Array.isArray(repositoryCheck?.errors) ? repositoryCheck.errors.join('; ') : 'invalid result';
    throw new Error(`Prepared release mirrors are inconsistent: ${details}`);
  }
  const manifestTag = getReleaseTag(repositoryCheck.manifest);
  if (manifestTag !== releaseTag) {
    throw new Error(`Prepared manifest resolves to ${manifestTag}, not release tag ${releaseTag}.`);
  }

  const parentManifest = readGitJson(root, parentCommit, 'shared/release.json', git);
  const parentVersion = parentManifest?.server?.version;
  const releaseVersion = repositoryCheck.manifest?.server?.version;
  const permittedNextVersions = ['patch', 'minor', 'major'].map((bump) => (
    nextReleaseVersion(parentVersion, bump)
  ));
  if (!permittedNextVersions.includes(releaseVersion)) {
    throw new Error(
      `Prepared release version ${releaseVersion} must be an exact patch, minor, or major advance from ${parentVersion}.`
    );
  }

  const parentSources = {};
  const candidateSources = {};
  const candidateFiles = nativeChanged ? { ...releasePaths, ...nativeReleasePaths } : releasePaths;
  for (const [key, relativePath] of Object.entries(candidateFiles)) {
    try {
      parentSources[key] = gitRaw(root, ['show', `${parentCommit}:${relativePath}`]);
      candidateSources[key] = gitRaw(root, ['show', `${checkoutCommit}:${relativePath}`]);
    } catch (error) {
      throw new Error(`Unable to read exact prepared release bytes for ${relativePath}.`, { cause: error });
    }
  }
  let expectedSources;
  try {
    const codeFloor = repositoryCheck.manifest.android.mobile.version_code - 1;
    const nativeSources = nativeChanged ? { ...parentSources, ...createNativeReleaseReplacements(parentSources, candidateNative, codeFloor) } : parentSources;
    expectedSources = { ...nativeSources, ...createServerReleaseReplacements(nativeSources, releaseVersion) };
  } catch (error) {
    throw new Error('Unable to reconstruct the canonical prepared release from its parent.', { cause: error });
  }
  for (const [key, relativePath] of Object.entries(candidateFiles)) {
    if (candidateSources[key] !== expectedSources[key]) {
      throw new Error(
        `Prepared release mirror ${relativePath} does not match the canonical transformation from its parent.`
      );
    }
  }

  const masterManifest = readGitJson(root, masterCommit, 'shared/release.json', git);
  const currentStableTag = getReleaseTag(masterManifest);
  if (publishLatest && !candidateParentCurrentMaster && releaseTag !== currentStableTag) {
    throw new Error(
      `Refusing to publish latest for ${releaseTag}; current origin/master manifest resolves to ${currentStableTag}.`
    );
  }

  return {
    releaseTag,
    sourceCommit: checkoutCommit,
    parentCommit,
    masterCommit,
    currentStableTag
  };
};

/** Validate an exact canonical candidate before merge or publication. */
export async function verifyPreparedReleaseCandidate({
  root = REPOSITORY_ROOT,
  releaseTag,
  expectedCommit = null,
  publishLatest = false,
  candidateParentCurrentMaster = false,
  git = runGit,
  gitRaw = git === runGit ? runGitRaw : git,
  checkRepositoryFn = checkRepository
}) {
  return validatePreparedReleaseCandidate({
    root,
    releaseTag,
    expectedCommit,
    publishLatest,
    candidateParentCurrentMaster,
    git,
    gitRaw,
    checkRepositoryFn,
    masterAlreadyFetched: false
  });
}

/** Read and validate the complete parent set used to prove merge ancestry. */
const readCommitParents = (root, commit, label, git) => {
  const parts = git(root, ['rev-list', '--parents', '-n', '1', commit]).trim().split(/\s+/);
  if (parts[0] !== commit || parts.some((part) => !/^[0-9a-f]{40}$/.test(part))) {
    throw new Error(`${label} returned malformed Git ancestry.`);
  }
  return parts.slice(1);
};

/**
 * Refuse current credentials to stale workflow code. The sole exception is the exact canonical
 * release child/merge produced by Cut release, whose tree cannot change workflow or tooling files.
 */
export async function verifyCurrentReleaseWorkflow({
  root = REPOSITORY_ROOT,
  workflowSha,
  releaseCommit = null,
  git = runGit,
  gitRaw = git === runGit ? runGitRaw : git,
  checkRepositoryFn = checkRepository
}) {
  requireCommitId(workflowSha, 'Workflow commit');
  git(root, [
    'fetch',
    '--force',
    '--no-tags',
    'origin',
    '+refs/heads/master:refs/remotes/origin/master'
  ]);
  const masterCommit = requireCommitId(
    git(root, ['rev-parse', '--verify', 'refs/remotes/origin/master^{commit}']),
    'Current protected master commit'
  );
  if (masterCommit === workflowSha) {
    return { mode: 'current-master', workflowCommit: workflowSha, masterCommit };
  }

  requireCommitId(releaseCommit, 'Canonical release commit');
  const candidateParents = readCommitParents(root, releaseCommit, 'Canonical release commit', git);
  if (candidateParents.length !== 1 || candidateParents[0] !== workflowSha) {
    throw new Error(
      `Stale workflow ${workflowSha} is not the sole parent of canonical release ${releaseCommit}.`
    );
  }

  const masterParents = readCommitParents(root, masterCommit, 'Current protected master commit', git);
  let mode;
  if (masterCommit === releaseCommit) {
    if (masterParents.length !== 1 || masterParents[0] !== workflowSha) {
      throw new Error('Current protected master is not the exact canonical release child.');
    }
    mode = 'canonical-release-child';
  } else {
    if (
      masterParents.length !== 2
      || masterParents[0] !== workflowSha
      || masterParents[1] !== releaseCommit
    ) {
      throw new Error('Current protected master is not the exact canonical Cut release merge.');
    }
    const masterTree = requireCommitId(
      git(root, ['rev-parse', '--verify', `${masterCommit}^{tree}`]),
      'Current protected master tree'
    );
    const releaseTree = requireCommitId(
      git(root, ['rev-parse', '--verify', `${releaseCommit}^{tree}`]),
      'Canonical release tree'
    );
    if (masterTree !== releaseTree) {
      throw new Error('Current protected master tree differs from the canonical release tree.');
    }
    mode = 'canonical-release-merge';
  }

  git(root, ['checkout', '--quiet', '--detach', releaseCommit]);
  let manifest;
  try {
    manifest = JSON.parse(git(root, ['show', `${releaseCommit}:shared/release.json`]));
  } catch (error) {
    throw new Error('Canonical release manifest could not be read.', { cause: error });
  }
  const releaseTag = getReleaseTag(manifest);
  await validatePreparedReleaseCandidate({
    root,
    releaseTag,
    expectedCommit: releaseCommit,
    publishLatest: true,
    candidateParentCurrentMaster: false,
    git,
    gitRaw,
    checkRepositoryFn,
    masterAlreadyFetched: true
  });
  return { mode, workflowCommit: workflowSha, masterCommit, releaseCommit, releaseTag };
}

/** Require the origin-authoritative tag and canonical protected release source. */
export async function verifyPreparedRelease({
  root = REPOSITORY_ROOT,
  releaseTag,
  expectedCommit = null,
  publishLatest = false,
  git = runGit,
  gitRaw = git === runGit ? runGitRaw : git,
  checkRepositoryFn = checkRepository
}) {
  if (typeof releaseTag !== 'string' || !RELEASE_TAG_PATTERN.test(releaseTag)) {
    throw new Error('Prepared release tag must match vMAJOR.MINOR.PATCH.');
  }
  if (expectedCommit === null) throw new Error('Expected release commit is required.');
  requireCommitId(expectedCommit, 'Expected release commit');
  if (typeof publishLatest !== 'boolean') throw new Error('publishLatest must be a boolean.');

  const tagRef = `refs/tags/${releaseTag}`;
  let remoteTagSource;
  try {
    remoteTagSource = git(root, ['ls-remote', '--tags', '--refs', 'origin', tagRef]);
  } catch (error) {
    throw new Error(`Unable to read exact release tag ${releaseTag} from origin.`, { cause: error });
  }
  const remoteLines = remoteTagSource.split(/\r?\n/).filter((line) => line.length > 0);
  if (remoteLines.length !== 1) {
    throw new Error(`Release tag ${releaseTag} must have exactly one published ref on origin.`);
  }
  const remoteMatch = remoteLines[0].match(/^([0-9a-f]{40})\s+(refs\/tags\/[^\s]+)$/);
  if (!remoteMatch || remoteMatch[2] !== tagRef) {
    throw new Error(`Origin returned a malformed exact ref for release tag ${releaseTag}.`);
  }
  const remoteTagObject = remoteMatch[1];

  try {
    git(root, [
      'fetch',
      '--force',
      '--no-tags',
      'origin',
      '+refs/heads/master:refs/remotes/origin/master',
      `+${tagRef}:${tagRef}`
    ]);
  } catch (error) {
    throw new Error(`Unable to fetch release tag ${releaseTag} and origin/master.`, { cause: error });
  }

  const localTagObject = requireCommitId(
    git(root, ['rev-parse', '--verify', `${tagRef}^{object}`]),
    'Fetched release tag object'
  );
  if (localTagObject !== remoteTagObject) {
    throw new Error(`Fetched release tag ${releaseTag} does not match its exact object on origin.`);
  }
  if (git(root, ['cat-file', '-t', tagRef]) !== 'tag') {
    throw new Error(`Release tag ${releaseTag} must be an annotated tag.`);
  }
  const tagCommit = parseAnnotatedReleaseTag(git(root, ['cat-file', '-p', tagRef]), releaseTag);
  const peeledCommit = requireCommitId(
    git(root, ['rev-parse', '--verify', `${tagRef}^{commit}`]),
    'Peeled release tag target'
  );
  if (peeledCommit !== tagCommit) {
    throw new Error(`Release tag ${releaseTag} does not peel to its direct commit target.`);
  }

  if (tagCommit !== expectedCommit) {
    throw new Error(`Release tag ${releaseTag} targets ${tagCommit}, not expected commit ${expectedCommit}.`);
  }
  const candidate = await validatePreparedReleaseCandidate({
    root,
    releaseTag,
    expectedCommit,
    publishLatest,
    candidateParentCurrentMaster: false,
    git,
    gitRaw,
    checkRepositoryFn,
    masterAlreadyFetched: true
  });
  return { ...candidate, tagObject: remoteTagObject };
}

/** Read historical native tag objects from origin rather than local-only refs. */
const readRemoteNativeReleaseTags = (root, { remote = 'origin', git = runGit } = {}) => {
  let source;
  try {
    source = git(root, ['ls-remote', '--tags', '--refs', remote, 'refs/tags/native-v*']);
  } catch (error) {
    throw new Error(`Unable to read published native release tags from ${remote}.`, { cause: error });
  }

  const tags = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]+)\s+refs\/tags\/(native-v\d+\.\d+\.\d+)$/i);
    if (!match || !NATIVE_RELEASE_TAG_PATTERN.test(match[2])) continue;
    tags.set(match[2], match[1].toLowerCase());
  }
  return tags;
};

/** Choose the highest semantic historical native tag from verified refs. */
const latestNativeReleaseTagFromRefs = (tags) => [...tags.keys()].sort((left, right) => (
  compareSemver(right.slice('native-v'.length), left.slice('native-v'.length))
))[0] ?? null;

/** Find the highest stable server release tag for version preparation. */
export function getLatestStableTag(root = REPOSITORY_ROOT) {
  const tags = gitValue(root, ['tag', '--list', '--sort=-v:refname'], '');
  return tags.split(/\r?\n/).find((tag) => /^v\d+\.\d+\.\d+$/.test(tag)) || null;
}

/** Resolve the highest origin native tag for historical tooling. */
export function getLatestNativeReleaseTag(root = REPOSITORY_ROOT, options = {}) {
  return latestNativeReleaseTagFromRefs(readRemoteNativeReleaseTags(root, options));
}

/** Verify that a native baseline is published by origin and belongs to the published history. */
export function verifyPublishedNativeReleaseTag({
  root = REPOSITORY_ROOT,
  expectedTag,
  remote = 'origin',
  publishedBranch = 'master',
  git = runGit,
  verifyTagAttestation = verifyNativeTagAttestation,
  parseAllowedSigners = parseNativeTagAllowedSigners
}) {
  if (typeof expectedTag !== 'string' || !NATIVE_RELEASE_TAG_PATTERN.test(expectedTag)) {
    throw new Error(`Invalid expected native release tag: ${expectedTag}`);
  }

  const remoteTags = readRemoteNativeReleaseTags(root, { remote, git });
  const latestTag = latestNativeReleaseTagFromRefs(remoteTags);
  const tagRef = `refs/tags/${expectedTag}`;
  const remoteTagObject = remoteTags.get(expectedTag) ?? null;
  if (remoteTagObject === null) {
    const latestDetail = latestTag === null ? 'no native release tags are published' : `latest is ${latestTag}`;
    throw new Error(`${expectedTag} is not published on ${remote} (${latestDetail}).`);
  }
  if (latestTag !== expectedTag) {
    throw new Error(
      `Manifest native release ${expectedTag} must match the latest published native tag ${latestTag} on ${remote}.`
    );
  }

  let localTagObject = tryGit(root, ['rev-parse', '--verify', `${tagRef}^{object}`], git);
  let fetched = false;
  if (localTagObject === null) {
    try {
      git(root, ['fetch', '--no-tags', remote, `${tagRef}:${tagRef}`]);
    } catch (error) {
      throw new Error(`Unable to fetch published native release tag ${expectedTag} from ${remote}.`, { cause: error });
    }
    fetched = true;
    localTagObject = tryGit(root, ['rev-parse', '--verify', `${tagRef}^{object}`], git);
  }
  if (localTagObject === null) {
    throw new Error(`Fetched native release tag ${expectedTag} could not be resolved locally.`);
  }
  if (localTagObject.toLowerCase() !== remoteTagObject) {
    throw new Error(
      `Local native release tag ${expectedTag} does not match the published tag object on ${remote}.`
    );
  }

  const tagCommit = tryGit(root, ['rev-parse', '--verify', `${tagRef}^{commit}`], git);
  if (tagCommit === null) {
    throw new Error(`Published native release tag ${expectedTag} does not resolve to a commit.`);
  }

  try {
    git(root, ['fetch', '--no-tags', remote, `refs/heads/${publishedBranch}`]);
  } catch (error) {
    throw new Error(`Unable to fetch ${remote}/${publishedBranch} for native tag verification.`, { cause: error });
  }
  const publishedCommit = tryGit(root, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], git);
  if (publishedCommit === null) {
    throw new Error(`Fetched ${remote}/${publishedBranch} could not be resolved to a commit.`);
  }

  let allowedSignersSource;
  try {
    allowedSignersSource = git(root, [
      'show',
      `${publishedCommit}:${NATIVE_TAG_ALLOWED_SIGNERS_REPOSITORY_PATH}`
    ]);
  } catch (error) {
    throw new Error(
      `Unable to read native release tag signers from ${remote}/${publishedBranch} commit ${publishedCommit}.`,
      { cause: error }
    );
  }
  let parsedAllowedSigners;
  try {
    parsedAllowedSigners = parseAllowedSigners(allowedSignersSource);
  } catch (error) {
    throw new Error(
      `Native release tag signers at ${remote}/${publishedBranch} commit ${publishedCommit} are invalid.`,
      { cause: error }
    );
  }
  if (typeof parsedAllowedSigners?.normalizedContents !== 'string') {
    throw new Error('Native release tag signer parser returned invalid normalized contents.');
  }
  try {
    git(root, ['merge-base', '--is-ancestor', tagCommit, publishedCommit]);
  } catch (error) {
    throw new Error(
      `Published native release tag ${expectedTag} is not on ${remote}/${publishedBranch} history.`,
      { cause: error }
    );
  }

  const headCommit = tryGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'], git);
  if (headCommit === null) throw new Error('The current checkout HEAD could not be resolved to a commit.');
  try {
    git(root, ['merge-base', '--is-ancestor', tagCommit, headCommit]);
  } catch (error) {
    throw new Error(
      `Current checkout does not descend from published native release tag ${expectedTag}.`,
      { cause: error }
    );
  }

  let attestation;
  try {
    attestation = verifyTagAttestation({
      repositoryRoot: root,
      tag: expectedTag,
      expectedCommit: tagCommit.toLowerCase(),
      allowedSigners: parsedAllowedSigners.normalizedContents
    });
  } catch (error) {
    throw new Error(`Published native release tag ${expectedTag} failed signed attestation verification.`, {
      cause: error
    });
  }
  if (attestation?.tagObject?.toLowerCase() !== remoteTagObject) {
    throw new Error(
      `Signed attestation for ${expectedTag} verified tag object ${attestation?.tagObject ?? 'unknown'}, ` +
      `not the exact object ${remoteTagObject} published on ${remote}.`
    );
  }

  return {
    latestTag,
    tagObject: remoteTagObject,
    tagCommit,
    publishedCommit,
    trustSetCommit: publishedCommit,
    fetched,
    attestation
  };
}

/** Allocate globally unique odd/even codes above both checked-in and previously abandoned reservations. */
export function getNextNativeVersionCodes(manifest, minimumCode = 0) {
  const currentCodes = [manifest?.android?.mobile?.version_code, manifest?.android?.wear?.version_code];
  if (currentCodes.some((code) => !Number.isSafeInteger(code) || code < 1)) {
    throw new Error('Native version codes must be positive safe integers before allocation.');
  }
  if (!Number.isSafeInteger(minimumCode) || minimumCode < 0) throw new Error('Native code floor must be a non-negative integer.');
  const currentMaximum = Math.max(...currentCodes, minimumCode);
  let mobileVersionCode = currentMaximum + 1;
  if (mobileVersionCode % 2 === 0) mobileVersionCode += 1;
  const wearVersionCode = mobileVersionCode + 1;
  if (wearVersionCode > GOOGLE_PLAY_MAX_VERSION_CODE) {
    throw new Error(`Native version codes cannot exceed Google Play's ${GOOGLE_PLAY_MAX_VERSION_CODE} limit.`);
  }
  return { mobileVersionCode, wearVersionCode };
}

/** Prepare every checked-in server/web release mirror and roll back the batch on validation failure. */
export async function prepareServerRelease({ root = REPOSITORY_ROOT, bump, latestTag = getLatestStableTag(root) }) {
  if (!RELEASE_BUMPS.has(bump)) throw new Error('Release bump must be major, minor, or patch.');
  if (latestTag === null) throw new Error('Cannot prepare a release without an existing stable release tag.');

  const beforeCheck = await checkRepository(root);
  if (beforeCheck.errors.length > 0) {
    throw new Error(`Release configuration is inconsistent before preparation:\n- ${beforeCheck.errors.join('\n- ')}`);
  }

  const currentVersion = beforeCheck.manifest.server.version;
  const currentPlan = getReleasePlan(beforeCheck.manifest, latestTag);
  if (currentPlan.should_release) {
    throw new Error(
      `Manifest version ${currentVersion} is already ahead of ${latestTag}. Publish the pending release before preparing another.`
    );
  }
  const nextVersion = nextReleaseVersion(currentVersion, bump);
  const files = Object.fromEntries(
    Object.entries(SERVER_RELEASE_FILE_PATHS).map(([key, relativePath]) => [key, path.join(root, relativePath)])
  );
  const originals = Object.fromEntries(
    await Promise.all(Object.entries(files).map(async ([key, filePath]) => [key, await readFile(filePath, 'utf8')]))
  );
  const replacements = createServerReleaseReplacements(originals, nextVersion);

  const writtenKeys = [];
  try {
    for (const [key, filePath] of Object.entries(files)) {
      await writeFile(filePath, replacements[key]);
      writtenKeys.push(key);
    }
    const afterCheck = await checkRepository(root);
    if (afterCheck.errors.length > 0) {
      throw new Error(`Prepared release configuration is inconsistent:\n- ${afterCheck.errors.join('\n- ')}`);
    }
  } catch (error) {
    await Promise.all(writtenKeys.map((key) => writeFile(files[key], originals[key])));
    throw error;
  }
  return nextVersion;
}

/** Prepare the shared mobile/Wear release and roll back every mirror if validation fails. */
export async function prepareNativeRelease({
  root = REPOSITORY_ROOT,
  bump,
  minimumCode = 0,
  verifyNativeReleaseTag = null
}) {
  return prepareNativeVersion({ root, bump, minimumCode, verifyNativeReleaseTag });
}

/** Reserve a local internal candidate without claiming a protected release attestation. */
export async function prepareLocalInternalNativeRelease({ root = REPOSITORY_ROOT, bump }) {
  return prepareNativeVersion({ root, bump });
}

/** Allocate one paired native version and roll back every mirror if validation fails. */
async function prepareNativeVersion({ root, bump, minimumCode = 0, verifyNativeReleaseTag }) {
  if (!RELEASE_BUMPS.has(bump)) throw new Error('Release bump must be major, minor, or patch.');

  const beforeCheck = await checkRepository(root);
  if (beforeCheck.errors.length > 0) {
    throw new Error(`Release configuration is inconsistent before native preparation:\n- ${beforeCheck.errors.join('\n- ')}`);
  }

  const currentVersion = beforeCheck.manifest.android.mobile.version_name;
  const currentWearVersion = beforeCheck.manifest.android.wear.version_name;
  if (!STABLE_SEMVER_PATTERN.test(currentVersion) || currentWearVersion !== currentVersion) {
    throw new Error('Paired native preparation requires matching stable phone and Wear version names.');
  }
  const currentNativeTag = `native-v${currentVersion}`;
  if (verifyNativeReleaseTag) {
    const verification = await verifyNativeReleaseTag({ root, expectedTag: currentNativeTag });
    const latestTag = verification?.latestTag ?? null;
    if (latestTag === null) {
      throw new Error(`Cannot prepare another native release until ${currentNativeTag} has been published.`);
    }
    if (!NATIVE_RELEASE_TAG_PATTERN.test(latestTag)) {
      throw new Error(`Invalid latest native release tag: ${latestTag}`);
    }
    if (latestTag !== currentNativeTag) {
      throw new Error(
        `Manifest native release ${currentNativeTag} must match the latest native tag ${latestTag} before preparation.`
      );
    }
  }

  const nextVersion = nextReleaseVersion(currentVersion, bump);
  const nextNativeTag = `native-v${nextVersion}`;
  const { mobileVersionCode, wearVersionCode } = getNextNativeVersionCodes(beforeCheck.manifest, minimumCode);
  const optionalMobileGradlePath = path.join(root, 'mobile', 'android', 'app', 'build.gradle');
  const optionalMobileGradle = await readOptionalFile(optionalMobileGradlePath);
  const files = {
    manifest: path.join(root, 'shared', 'release.json'),
    diagnostics: path.join(root, 'shared', 'client-diagnostic-versions.json'),
    rootLock: path.join(root, 'package-lock.json'),
    mobilePackage: path.join(root, 'mobile', 'package.json'),
    mobileApp: path.join(root, 'mobile', 'app.json'),
    pairingPackage: path.join(root, 'mobile', 'modules', 'wear-pairing', 'package.json'),
    pairingGradle: path.join(root, 'mobile', 'modules', 'wear-pairing', 'android', 'build.gradle'),
    wearGradle: path.join(root, 'wear', 'app', 'build.gradle.kts'),
    openApi: path.join(root, 'backend', 'openapi', 'v1.yaml'),
    generatedApi: path.join(root, 'packages', 'api-client', 'src', 'generated', 'v1.ts')
  };
  if (optionalMobileGradle !== null) files.mobileGradle = optionalMobileGradlePath;

  const originals = Object.fromEntries(
    await Promise.all(Object.entries(files).map(async ([key, filePath]) => [key, await readFile(filePath, 'utf8')]))
  );
  const replacements = createNativeReleaseReplacements(originals, nextVersion, minimumCode);
  const writtenKeys = [];
  try {
    for (const [key, filePath] of Object.entries(files)) {
      writtenKeys.push(key);
      await writeFile(filePath, replacements[key]);
    }
    const afterCheck = await checkRepository(root);
    if (afterCheck.errors.length > 0) {
      throw new Error(`Prepared native release configuration is inconsistent:\n- ${afterCheck.errors.join('\n- ')}`);
    }
  } catch (error) {
    await Promise.all(writtenKeys.map((key) => writeFile(files[key], originals[key])));
    throw error;
  }

  return {
    version_name: nextVersion,
    mobile_version_code: mobileVersionCode,
    wear_version_code: wearVersionCode,
    native_release_tag: nextNativeTag
  };
}


export const NATIVE_RELEASE_FILE_PATHS = Object.freeze({
  "manifest": "shared/release.json",
  "diagnostics": "shared/client-diagnostic-versions.json",
  "rootLock": "package-lock.json",
  "mobilePackage": "mobile/package.json",
  "mobileApp": "mobile/app.json",
  "pairingPackage": "mobile/modules/wear-pairing/package.json",
  "pairingGradle": "mobile/modules/wear-pairing/android/build.gradle",
  "wearGradle": "wear/app/build.gradle.kts",
  "openApi": "backend/openapi/v1.yaml",
  "generatedApi": "packages/api-client/src/generated/v1.ts"
});

/** Reconstruct paired native version mirrors from parent bytes without executing source code. */
export function createNativeReleaseReplacements(originals, nextVersion, minimumCode = 0) {
  const manifest = JSON.parse(originals.manifest);
  const { mobileVersionCode, wearVersionCode } = getNextNativeVersionCodes(manifest, minimumCode);
  const nextNativeTag = 'native-v' + nextVersion;
  const diagnostics = JSON.parse(originals.diagnostics);
  const rootLock = JSON.parse(originals.rootLock);
  const mobilePackage = JSON.parse(originals.mobilePackage);
  const mobileApp = JSON.parse(originals.mobileApp);
  const pairingPackage = JSON.parse(originals.pairingPackage);
  const currentPhoneDiagnosticVersions = [...diagnostics.supported_versions.android_phone];
  const currentIosDiagnosticVersions = [...diagnostics.supported_versions.ios];
  const currentWearDiagnosticVersions = [...diagnostics.supported_versions.wear_os];
  /** Retain the bounded diagnostic compatibility window when advancing a native version. */
  const advanceDiagnosticVersions = (versions) =>
    [nextVersion, ...versions.filter((version) => version !== nextVersion)]
      .slice(0, MAX_CLIENT_DIAGNOSTIC_VERSIONS_PER_PLATFORM);

  manifest.android.mobile.version_name = nextVersion;
  manifest.android.mobile.version_code = mobileVersionCode;
  manifest.android.mobile.native_release_tag = nextNativeTag;
  manifest.android.wear.version_name = nextVersion;
  manifest.android.wear.version_code = wearVersionCode;
  diagnostics.supported_versions.android_phone = advanceDiagnosticVersions(currentPhoneDiagnosticVersions);
  diagnostics.supported_versions.ios = advanceDiagnosticVersions(currentIosDiagnosticVersions);
  diagnostics.supported_versions.wear_os = advanceDiagnosticVersions(currentWearDiagnosticVersions);
  rootLock.packages.mobile.version = nextVersion;
  rootLock.packages['mobile/modules/wear-pairing'].version = nextVersion;
  mobilePackage.version = nextVersion;
  mobileApp.expo.version = nextVersion;
  mobileApp.expo.android.versionCode = mobileVersionCode;
  mobileApp.expo.ios.buildNumber = String(mobileVersionCode);
  mobileApp.expo.extra.calibrate.nativeReleaseTag = nextNativeTag;
  pairingPackage.version = nextVersion;

  let pairingGradle = replacePatternExactlyOnce(
    originals.pairingGradle,
    /^version\s*=\s*["'][^"']+["']/gm,
    `version = '${nextVersion}'`,
    'Wear pairing module version'
  );
  pairingGradle = replacePatternExactlyOnce(
    pairingGradle,
    /versionCode\s+\d+/g,
    `versionCode ${mobileVersionCode}`,
    'Wear pairing module versionCode'
  );
  pairingGradle = replacePatternExactlyOnce(
    pairingGradle,
    /versionName\s+["'][^"']+["']/g,
    `versionName '${nextVersion}'`,
    'Wear pairing module versionName'
  );
  let wearGradle = replacePatternExactlyOnce(
    originals.wearGradle,
    /versionCode\s*=\s*\d+/g,
    `versionCode = ${wearVersionCode}`,
    'Wear versionCode'
  );
  wearGradle = replacePatternExactlyOnce(
    wearGradle,
    /versionName\s*=\s*"[^"]+"/g,
    `versionName = "${nextVersion}"`,
    'Wear versionName'
  );

  const nextPhoneDiagnosticVersions = diagnostics.supported_versions.android_phone;
  const nextIosDiagnosticVersions = diagnostics.supported_versions.ios;
  const nextWearDiagnosticVersions = diagnostics.supported_versions.wear_os;
  /** Render one platform diagnostic enum in the canonical OpenAPI layout. */
  const openApiLine = (platform, versions) =>
    `- properties: { platform: { const: ${platform} }, version: { enum: [${versions.join(', ')}] } }`;
  const generatedNewline = originals.generatedApi.includes('\r\n') ? '\r\n' : '\n';
  /** Render the matching generated client diagnostic version union. */
  const generatedBlock = (platform, versions) => [
    `platform?: "${platform}";`,
    '            /** @enum {unknown} */',
    `            version?: "${versions.join('" | "')}";`
  ].join(generatedNewline);

  const replacements = {
    manifest: formatJson(manifest, originals.manifest),
    diagnostics: formatJson(diagnostics, originals.diagnostics),
    rootLock: formatJson(rootLock, originals.rootLock),
    mobilePackage: formatJson(mobilePackage, originals.mobilePackage),
    mobileApp: formatJson(mobileApp, originals.mobileApp),
    pairingPackage: formatJson(pairingPackage, originals.pairingPackage),
    pairingGradle,
    wearGradle,
    openApi: replaceExactlyOnce(
      replaceExactlyOnce(
        originals.openApi,
        openApiLine('android_phone', currentPhoneDiagnosticVersions),
        openApiLine('android_phone', nextPhoneDiagnosticVersions),
        'backend/openapi/v1.yaml android_phone versions'
      ),
      openApiLine('wear_os', currentWearDiagnosticVersions),
      openApiLine('wear_os', nextWearDiagnosticVersions),
      'backend/openapi/v1.yaml wear_os versions'
    ),
    generatedApi: replaceExactlyOnce(
      replaceExactlyOnce(
        originals.generatedApi,
        generatedBlock('android_phone', currentPhoneDiagnosticVersions),
        generatedBlock('android_phone', nextPhoneDiagnosticVersions),
        'generated API android_phone versions'
      ),
      generatedBlock('wear_os', currentWearDiagnosticVersions),
      generatedBlock('wear_os', nextWearDiagnosticVersions),
      'generated API wear_os versions'
    )
  };
  replacements.openApi = replaceExactlyOnce(
    replacements.openApi,
    openApiLine('ios', currentIosDiagnosticVersions),
    openApiLine('ios', nextIosDiagnosticVersions),
    'backend/openapi/v1.yaml ios versions'
  );
  replacements.generatedApi = replaceExactlyOnce(
    replacements.generatedApi,
    generatedBlock('ios', currentIosDiagnosticVersions),
    generatedBlock('ios', nextIosDiagnosticVersions),
    'generated API ios versions'
  );
  if (originals.mobileGradle) {
    let mobileGradle = replacePatternExactlyOnce(
      originals.mobileGradle,
      /versionCode\s+\d+/g,
      `versionCode ${mobileVersionCode}`,
      'generated mobile versionCode'
    );
    mobileGradle = replacePatternExactlyOnce(
      mobileGradle,
      /versionName\s+["'][^"']+["']/g,
      `versionName "${nextVersion}"`,
      'generated mobile versionName'
    );
    replacements.mobileGradle = mobileGradle;
  }

  return replacements;
}

/** Hash a release artifact and record its portable relative identity. */
const artifactMetadata = async (root, artifact) => {
  const [label, rawPath] = artifact.includes('=') ? artifact.split(/=(.*)/s, 2) : [path.basename(artifact), artifact];
  const absolutePath = path.resolve(root, rawPath);
  const contents = await readFile(absolutePath);
  const fileStats = await stat(absolutePath);
  return {
    label,
    file_name: path.basename(absolutePath),
    bytes: fileStats.size,
    sha256: createHash('sha256').update(contents).digest('hex')
  };
};

/** Build deterministic source/version/artifact metadata for retained release evidence. */
export async function createReleaseMetadata({ manifest, channel, artifacts = [], root = REPOSITORY_ROOT, sourceDateEpoch = process.env.SOURCE_DATE_EPOCH }) {
  if (!manifest.android.channels[channel]) throw new Error(`Unknown release channel: ${channel}`);
  const commit = gitValue(root, ['rev-parse', 'HEAD']);
  const status = gitValue(root, ['status', '--porcelain'], '');
  const artifactRecords = await Promise.all([...artifacts].sort().map((artifact) => artifactMetadata(root, artifact)));
  const metadata = {
    schema_version: 1,
    channel,
    source: {
      git_commit: commit,
      git_dirty: Boolean(status)
    },
    server: manifest.server,
    android: {
      application_id: manifest.android.application_id,
      mobile: manifest.android.mobile,
      wear: manifest.android.wear
    },
    artifacts: artifactRecords
  };
  if (sourceDateEpoch !== undefined) {
    const epoch = Number(sourceDateEpoch);
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer.');
    metadata.source.source_date_epoch = epoch;
    metadata.generated_at = new Date(epoch * 1000).toISOString();
  }
  return metadata;
}

const COMMAND_OPTIONS = new Map([
  ['check', new Set(['--repository-root', '--validation-mode'])],
  ['metadata', new Set(['--artifact', '--channel'])],
  ['plan', new Set(['--latest-tag'])],
  ['prepare', new Set(['--bump'])],
  ['prepare-native', new Set(['--bump', '--minimum-native-code'])],
  ['tag', new Set(['--latest-tag', '--repository-root', '--validation-mode'])],
  ['verify-prepared', new Set([
    '--expected-commit',
    '--publish-latest',
    '--release-tag',
    '--repository-root'
  ])],
  ['verify-prepared-candidate', new Set([
    '--candidate-parent-current-master',
    '--expected-commit',
    '--publish-latest',
    '--release-tag',
    '--repository-root'
  ])],
  ['verify-current-release-workflow', new Set([
    '--release-commit',
    '--repository-root',
    '--workflow-sha'
  ])]
]);
const REPEATABLE_OPTIONS = new Set(['--artifact']);

/** Reject unknown or incomplete release CLI options before performing work. */
const parseArguments = (args) => {
  const command = args[0] ?? 'check';
  const allowedOptions = COMMAND_OPTIONS.get(command);
  if (allowedOptions === undefined) throw new Error(`Unknown command: ${command}`);
  const result = {
    command,
    channel: null,
    artifacts: [],
    latestTag: null,
    bump: null,
    minimumNativeCode: 0,
    repositoryRoot: null,
    validationMode: 'current',
    releaseTag: null,
    expectedCommit: null,
    publishLatest: null,
    candidateParentCurrentMaster: null,
    workflowSha: null,
    releaseCommit: null
  };
  const seen = new Set();
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (!allowedOptions.has(option)) throw new Error(`Unknown argument for ${command}: ${option}`);
    if (!REPEATABLE_OPTIONS.has(option) && seen.has(option)) {
      throw new Error(`Duplicate argument for ${command}: ${option}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new Error(`${option} requires a value.`);
    }
    seen.add(option);
    index += 1;
    if (option === '--channel') result.channel = value;
    else if (option === '--artifact') result.artifacts.push(value);
    else if (option === '--latest-tag') result.latestTag = value;
    else if (option === '--bump') result.bump = value;
    else if (option === '--minimum-native-code') result.minimumNativeCode = Number(value);
    else if (option === '--release-tag') result.releaseTag = value;
    else if (option === '--expected-commit') result.expectedCommit = value;
    else if (option === '--publish-latest') result.publishLatest = value;
    else if (option === '--candidate-parent-current-master') result.candidateParentCurrentMaster = value;
    else if (option === '--workflow-sha') result.workflowSha = value;
    else if (option === '--release-commit') result.releaseCommit = value;
    else if (option === '--validation-mode') {
      if (!RELEASE_VALIDATION_MODES.has(value)) {
        throw new Error(`Unknown release validation mode: ${value}`);
      }
      result.validationMode = value;
    }
    else if (option === '--repository-root') {
      if (value.includes('\0')) throw new Error('--repository-root contains an invalid NUL byte.');
      result.repositoryRoot = path.resolve(value);
    }
  }
  return result;
};

/** Dispatch explicit release operations and report failures without hiding their cause. */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'prepare') {
    if (!options.bump) throw new Error('prepare requires --bump major, minor, or patch.');
    if (options.latestTag !== null) throw new Error('prepare reads the latest stable tag from Git; do not pass --latest-tag.');
    console.log(await prepareServerRelease({ bump: options.bump }));
    return;
  }
  if (options.command === 'prepare-native') {
    if (!options.bump) throw new Error('prepare-native requires --bump major, minor, or patch.');
    if (options.latestTag !== null) {
      throw new Error('prepare-native reads the latest native tag from Git; do not pass --latest-tag.');
    }
    console.log(`${JSON.stringify(await prepareNativeRelease({ bump: options.bump, minimumCode: options.minimumNativeCode }), null, 2)}\n`);
    return;
  }
  if (options.command === 'verify-prepared' || options.command === 'verify-prepared-candidate') {
    if (!options.releaseTag) {
      throw new Error(`${options.command} requires --release-tag vMAJOR.MINOR.PATCH.`);
    }
    if (!['true', 'false'].includes(options.publishLatest)) {
      throw new Error(`${options.command} requires --publish-latest true or false.`);
    }
    if (
      options.candidateParentCurrentMaster !== null
      && !['true', 'false'].includes(options.candidateParentCurrentMaster)
    ) {
      throw new Error('--candidate-parent-current-master must be true or false.');
    }
    const verify = options.command === 'verify-prepared'
      ? verifyPreparedRelease
      : verifyPreparedReleaseCandidate;
    const verification = await verify({
      root: options.repositoryRoot ?? REPOSITORY_ROOT,
      releaseTag: options.releaseTag,
      expectedCommit: options.expectedCommit,
      publishLatest: options.publishLatest === 'true',
      candidateParentCurrentMaster: options.candidateParentCurrentMaster === 'true'
    });
    console.log(`${JSON.stringify(verification, null, 2)}\n`);
    return;
  }
  if (options.command === 'verify-current-release-workflow') {
    const verification = await verifyCurrentReleaseWorkflow({
      root: options.repositoryRoot ?? REPOSITORY_ROOT,
      workflowSha: options.workflowSha,
      releaseCommit: options.releaseCommit
    });
    console.log(`${JSON.stringify(verification, null, 2)}\n`);
    return;
  }
  const root = options.repositoryRoot ?? REPOSITORY_ROOT;
  const { manifest, errors } = await checkRepository(root, { validationMode: options.validationMode });
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  if (options.command === 'check') {
    console.log('Release configuration is consistent.');
    return;
  }
  if (options.command === 'metadata') {
    if (!options.channel) throw new Error('metadata requires --channel debug, internal, or production.');
    console.log(`${JSON.stringify(await createReleaseMetadata({ manifest, channel: options.channel, artifacts: options.artifacts }), null, 2)}\n`);
    return;
  }
  if (options.command === 'tag') {
    console.log(getReleaseTag(manifest, options.latestTag));
    return;
  }
  if (options.command === 'plan') {
    const plan = getReleasePlan(manifest, options.latestTag);
    console.log(`latest_tag=${plan.latest_tag}`);
    console.log(`new_tag=${plan.new_tag}`);
    console.log(`should_release=${plan.should_release}`);
    return;
  }
  throw new Error(`Unknown command: ${options.command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
