/** @file Calibrate metadata mappings, diagnostic compatibility windows and application-specific release assertions. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { compareVersions as compareSemver } from '@mchartier/expo-release/engine';
import { fileURLToPath, pathToFileURL } from 'node:url';


const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
export const RELEASE_MANIFEST_PATH = path.join(REPOSITORY_ROOT, 'shared', 'release.json');
export const GOOGLE_PLAY_MAX_VERSION_CODE = 2_100_000_000;

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const STABLE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NATIVE_RELEASE_TAG_PATTERN = /^native-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HISTORICAL_NATIVE_RELEASE_TAG_PATTERN = /^(?:native-)?v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_VALIDATION_MODES = new Set(['current', 'historical-prepared']);
export const HISTORICAL_PREPARED_RELEASE_COMMIT = '93ff7474521fd93456027df0729d8797e9c47b54';
const SERVER_RELEASE_FILE_PATHS = Object.freeze({
  manifest: 'shared/release.json',
  diagnostics: 'shared/client-diagnostic-versions.json',
  rootPackage: 'package.json',
  rootLock: 'package-lock.json',
  backendPackage: 'backend/package.json',
  backendLock: 'backend/package-lock.json',
  openApi: 'docs/openapi/v1.yaml',
  generatedApi: 'packages/api-client/src/generated/v1.ts'
});
export const PREPARED_RELEASE_MIRROR_PATHS = Object.freeze(
  Object.values(SERVER_RELEASE_FILE_PATHS).sort()
);
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
    ? sourceCommit
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
    readFile(path.join(root, 'docs', 'openapi', 'v1.yaml'), 'utf8'),
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

export const NATIVE_RELEASE_FILE_PATHS = Object.freeze({
  "manifest": "shared/release.json",
  "diagnostics": "shared/client-diagnostic-versions.json",
  "rootLock": "package-lock.json",
  "mobilePackage": "mobile/package.json",
  "mobileApp": "mobile/app.json",
  "pairingPackage": "mobile/modules/wear-pairing/package.json",
  "pairingGradle": "mobile/modules/wear-pairing/android/build.gradle",
  "wearGradle": "wear/app/build.gradle.kts",
  "openApi": "docs/openapi/v1.yaml",
  "generatedApi": "packages/api-client/src/generated/v1.ts"
});

/** Reconstruct paired native version mirrors from parent bytes without executing source code. */
export function createNativeReleaseReplacements(originals, nextVersion, codes) {
  const manifest = JSON.parse(originals.manifest);
  const { mobileVersionCode, wearVersionCode } = codes;
  if (!Number.isSafeInteger(mobileVersionCode) || mobileVersionCode % 2 !== 1 || wearVersionCode !== mobileVersionCode + 1) {
    throw new Error('Calibrate requires the explicitly reserved consecutive odd/even pair.');
  }
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
        'docs/openapi/v1.yaml android_phone versions'
      ),
      openApiLine('wear_os', currentWearDiagnosticVersions),
      openApiLine('wear_os', nextWearDiagnosticVersions),
      'docs/openapi/v1.yaml wear_os versions'
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
    'docs/openapi/v1.yaml ios versions'
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


if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] !== 'check') throw new Error('Use npm run release for release operations.');
  const { errors } = await checkRepository();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Calibrate release metadata is consistent.');
}
