/** @file Regression coverage for release config: release checks reject a missing or stale iOS build number. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { overrideCheckoutVersions } from './native-upgrade-rehearsal.mjs';

import {
  GOOGLE_PLAY_MAX_VERSION_CODE,
  HISTORICAL_PREPARED_RELEASE_COMMIT,
  PREPARED_RELEASE_MIRROR_PATHS,
  NATIVE_RELEASE_FILE_PATHS,
  checkRepository,
  compareSemver,
  createServerReleaseReplacements,
  createReleaseMetadata,
  getNextNativeVersionCodes,
  getReleasePlan,
  getReleaseTag,
  nextReleaseVersion,
  prepareNativeRelease,
  prepareLocalInternalNativeRelease,
  prepareServerRelease,
  verifyPreparedRelease,
  verifyPreparedReleaseCandidate,
  verifyCurrentReleaseWorkflow,
  verifyPublishedNativeReleaseTag,
  validateClientDiagnosticVersionContract,
  validateManifest
} from './release-config.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseConfigScriptPath = path.join(repositoryRoot, 'scripts', 'release-config.mjs');
const nativeTagAllowedSignersRepositoryPath = '.github/native-release-tag-allowed-signers';

/** Encode an SSH string for historical tag-attestation fixtures. */
function sshString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** Provide the reviewed public signer fixture for historical verification. */
function nativeTagAllowedSigner(byte) {
  const keyType = 'ssh-ed25519';
  const blob = Buffer.concat([sshString(keyType), sshString(Buffer.alloc(32, byte))]);
  return `calibrate-native-release ${keyType} ${blob.toString('base64')}\n`;
}

const currentAllowedSigners = nativeTagAllowedSigner(1);
const releaseFixturePaths = [
  'package.json',
  'package-lock.json',
  'backend/package.json',
  'backend/package-lock.json',
  'mobile/package.json',
  'mobile/app.json',
  'mobile/eas.json',
  'mobile/modules/wear-pairing/package.json',
  'mobile/modules/wear-pairing/android/build.gradle',
  'wear/app/build.gradle.kts',
  'shared/release.json',
  'shared/client-diagnostic-versions.json',
  'backend/openapi/v1.yaml',
  'packages/api-client/src/generated/v1.ts'
];

/** Copy version mirrors into a temporary repository before mutation tests. */
async function createReleaseFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'calibrate-release-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relativePath of releaseFixturePaths) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(repositoryRoot, relativePath), target);
  }
  return root;
}

/** Read fixture metadata without touching the real application manifest. */
const readFixtureJson = async (root, relativePath) => JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));

// Exact manifest recorded at 93ff747 for the prepared v0.35.0 release.
const historicalPreparedV035Manifest = {
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

/** Model the exact supported pre-iOS historical release layout. */
async function useHistoricalPreparedV035Mirrors(root) {
  const current = await readFixtureJson(root, 'shared/release.json');
  const currentDiagnostics = await readFixtureJson(root, 'shared/client-diagnostic-versions.json');
  const laterNativeVersions = [...new Set([
    current.android.mobile.version_name,
    ...['android_phone', 'ios', 'wear_os'].flatMap(platform => currentDiagnostics.supported_versions[platform] ?? [])
  ])].filter(version => compareSemver(version, '0.2.6') > 0);
  // Freeze native mirrors too: future package/version changes must not rewrite historical evidence.
  for (const relativePath of releaseFixturePaths) {
    const file = path.join(root, relativePath);
    let source = await readFile(file, 'utf8');
    source = source.replaceAll(current.android.application_id, 'app.calibratehealth.mobile');
    for (const version of laterNativeVersions) source = source.replaceAll(version, '0.2.6');
    // Any number of later native releases may have extended each diagnostics representation.
    source = source.replace(/("0\.2\.6")(?:,\s*"0\.2\.6")+/g, '$1')
      .replace(/(0\.2\.6)(?:,\s*0\.2\.6)+/g, '$1')
      .replace(/("0\.2\.6")(?:\s*\|\s*"0\.2\.6")+/g, '$1');
    await writeFile(file, source);
  }

  const originals = Object.fromEntries(await Promise.all(
    Object.entries(preparedReleaseSourcePaths).map(async ([key, relativePath]) => [
      key, await readFile(path.join(root, relativePath), 'utf8')
    ])
  ));
  // Pin both historical server generations instead of inheriting the checkout's version.
  const historicalSources = createServerReleaseReplacements(
    createServerReleaseReplacements(originals, '0.34.1'),
    '0.35.0'
  );
  for (const [key, relativePath] of Object.entries(preparedReleaseSourcePaths)) {
    await writeFile(path.join(root, relativePath), historicalSources[key]);
  }
  await writeFile(
    path.join(root, 'shared', 'release.json'),
    `${JSON.stringify(historicalPreparedV035Manifest, null, 2)}\n`
  );

  const appJsonPath = path.join(root, 'mobile', 'app.json');
  const appJson = await readFixtureJson(root, 'mobile/app.json');
  appJson.expo.android.versionCode = 8;
  delete appJson.expo.ios;
  appJson.expo.extra.calibrate.nativeReleaseTag = 'v0.13.2';
  await writeFile(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`);

  const diagnostics = await readFixtureJson(root, 'shared/client-diagnostic-versions.json');
  delete diagnostics.supported_versions.ios;
  await writeFile(path.join(root, 'shared/client-diagnostic-versions.json'), JSON.stringify(diagnostics));

  const wearGradlePath = path.join(root, 'wear', 'app', 'build.gradle.kts');
  const wearGradle = await readFile(wearGradlePath, 'utf8');
  await writeFile(wearGradlePath, wearGradle.replace(/versionCode\s*=\s*\d+/, 'versionCode = 8'));

  const pairingGradlePath = path.join(root, 'mobile', 'modules', 'wear-pairing', 'android', 'build.gradle');
  const pairingGradle = await readFile(pairingGradlePath, 'utf8');
  await writeFile(pairingGradlePath, pairingGradle.replace(/versionCode\s+\d+/, 'versionCode 8'));
}

/** Introduce native mirror drift to prove current validation rejects it. */
async function useInvalidModernNativeMirrors(root) {
  const manifestPath = path.join(root, 'shared', 'release.json');
  const manifest = await readFixtureJson(root, 'shared/release.json');
  manifest.android.mobile.version_code = 10;
  manifest.android.mobile.native_release_tag = 'native-v0.2.5';
  manifest.android.wear.version_code = 10;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const appJsonPath = path.join(root, 'mobile', 'app.json');
  const appJson = await readFixtureJson(root, 'mobile/app.json');
  appJson.expo.android.versionCode = 10;
  appJson.expo.ios.buildNumber = '10';
  appJson.expo.extra.calibrate.nativeReleaseTag = 'native-v0.2.5';
  await writeFile(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`);

  const pairingGradlePath = path.join(root, 'mobile', 'modules', 'wear-pairing', 'android', 'build.gradle');
  const pairingGradle = await readFile(pairingGradlePath, 'utf8');
  await writeFile(pairingGradlePath, pairingGradle.replace(/versionCode\s+\d+/, 'versionCode 10'));
}

/** Assert the injected historical verifier receives the expected tag. */
const acceptExpectedNativeReleaseTag = ({ expectedTag }) => ({ latestTag: expectedTag });

/** Model origin, ancestry, and signed native tag observations. */
function createNativeTagGit({
  expectedTag = 'native-v0.2.6',
  remoteTagObject = 'a'.repeat(40),
  localTagObject = remoteTagObject,
  tagCommit = 'b'.repeat(40),
  publishedCommit = 'c'.repeat(40),
  headCommit = publishedCommit,
  tagOnPublishedBranch = true,
  tagOnHead = true,
  trustSetSource = currentAllowedSigners
} = {}) {
  let currentLocalTagObject = localTagObject;
  const calls = [];
  const tagRef = `refs/tags/${expectedTag}`;
  /** Provide a deterministic Git adapter for build identity inspection. */
  const git = (_root, args) => {
    calls.push(args);
    if (args[0] === 'ls-remote') {
      return remoteTagObject === null ? '' : `${remoteTagObject}\t${tagRef}`;
    }
    if (args[0] === 'fetch' && args[3] === `${tagRef}:${tagRef}`) {
      currentLocalTagObject = remoteTagObject;
      return '';
    }
    if (args[0] === 'fetch' && args[3] === 'refs/heads/master') return '';
    if (
      args[0] === 'show'
      && args[1] === `${publishedCommit}:${nativeTagAllowedSignersRepositoryPath}`
    ) {
      return trustSetSource;
    }
    if (args[0] === 'rev-parse') {
      if (args[2] === `${tagRef}^{object}`) {
        if (currentLocalTagObject === null) throw new Error('missing local tag');
        return currentLocalTagObject;
      }
      if (args[2] === `${tagRef}^{commit}`) return tagCommit;
      if (args[2] === 'FETCH_HEAD^{commit}') return publishedCommit;
      if (args[2] === 'HEAD^{commit}') return headCommit;
    }
    if (args[0] === 'merge-base' && args[3] === publishedCommit) {
      if (!tagOnPublishedBranch) throw new Error('not an ancestor');
      return '';
    }
    if (args[0] === 'merge-base' && args[3] === headCommit) {
      if (!tagOnHead) throw new Error('not an ancestor');
      return '';
    }
    throw new Error(`Unexpected git command: ${args.join(' ')}`);
  };
  return { calls, git, tagRef };
}

const validManifest = {
  schema_version: 1,
  server: { version: '1.2.3', api: { current: 'v1', supported: ['v1'] } },
  android: {
    application_id: 'net.darkmachines.healthtracker',
    mobile: {
      version_name: '2.0.0',
      version_code: 21,
      native_release_tag: 'native-v2.0.0',
      minimum_supported_version: '1.5.0'
    },
    wear: { version_name: '2.0.0', version_code: 10, minimum_supported_version: '1.0.0' },
    channels: { debug: {}, internal: {}, production: {} }
  }
};

const validDiagnosticVersions = {
  schema_version: 1,
  previous_web_release: '1.2.2',
  supported_versions: {
    web: ['1.2.3', '1.2.2'],
    android_phone: ['2.0.0', '1.5.0'],
    ios: ['2.0.0', '1.5.0'],
    wear_os: ['2.0.0', '1.0.0']
  }
};

const validDiagnosticOpenApi = `
- properties: { platform: { const: web }, version: { enum: [1.2.3, 1.2.2] } }
- properties: { platform: { const: android_phone }, version: { enum: [2.0.0, 1.5.0] } }
- properties: { platform: { const: ios }, version: { enum: [2.0.0, 1.5.0] } }
- properties: { platform: { const: wear_os }, version: { enum: [2.0.0, 1.0.0] } }
`;

const preparedReleaseSourcePaths = {
  manifest: 'shared/release.json',
  diagnostics: 'shared/client-diagnostic-versions.json',
  rootPackage: 'package.json',
  rootLock: 'package-lock.json',
  backendPackage: 'backend/package.json',
  backendLock: 'backend/package-lock.json',
  openApi: 'backend/openapi/v1.yaml',
  generatedApi: 'packages/api-client/src/generated/v1.ts'
};

/** Provide canonical parent bytes for candidate reconstruction tests. */
function createPreparedReleaseParentSources(version, previousVersion) {
  const manifest = structuredClone(validManifest);
  manifest.server.version = version;
  const diagnostics = structuredClone(validDiagnosticVersions);
  diagnostics.previous_web_release = previousVersion;
  diagnostics.supported_versions.web = [version, previousVersion];
  /** Render a package manifest fixture with a controlled version. */
  const packageSource = (name) => `${JSON.stringify({ name, version }, null, 2)}\n`;
  /** Render the matching lockfile version mirrors. */
  const lockSource = (name) => `${JSON.stringify({
    name,
    version,
    lockfileVersion: 3,
    packages: { '': { name, version } }
  }, null, 2)}\n`;
  return {
    manifest: `${JSON.stringify(manifest, null, 2)}\n`,
    diagnostics: `${JSON.stringify(diagnostics, null, 2)}\n`,
    rootPackage: packageSource('calibrate'),
    rootLock: lockSource('calibrate'),
    backendPackage: packageSource('calibrate-backend'),
    backendLock: lockSource('calibrate-backend'),
    openApi: `- properties: { platform: { const: web }, version: { enum: [${version}, ${previousVersion}] } }\n`,
    generatedApi: `export type WebDiagnostic = { version?: "${version}" | "${previousVersion}"; };\n`
  };
}

/** Model exact candidate Git observations without publishing any refs. */
function createPreparedReleaseGit({
  releaseTag = 'v1.2.3',
  remoteTagObject = 'a'.repeat(40),
  localTagObject = remoteTagObject,
  tagCommit = 'b'.repeat(40),
  peeledCommit = tagCommit,
  checkoutCommit = tagCommit,
  masterCommit = 'c'.repeat(40),
  parentCommit = 'd'.repeat(40),
  parentCommits = [parentCommit],
  tagObjectKind = 'tag',
  directTargetType = 'commit',
  internalTag = releaseTag,
  onMaster = true,
  changedPaths = PREPARED_RELEASE_MIRROR_PATHS,
  changedStatus = 'M',
  parentVersion = '1.2.2',
  masterVersion = '1.2.3',
  targetManifest = validManifest,
  targetSourceMutator = (sources) => sources,
  checkErrors = []
} = {}) {
  const calls = [];
  const checkCalls = [];
  const tagRef = `refs/tags/${releaseTag}`;
  const parentParts = parentVersion.split('.').map(Number);
  const previousVersion = parentParts[2] > 0
    ? `${parentParts[0]}.${parentParts[1]}.${parentParts[2] - 1}`
    : parentVersion;
  const parentSources = createPreparedReleaseParentSources(parentVersion, previousVersion);
  const targetSources = targetSourceMutator({
    ...createServerReleaseReplacements(parentSources, targetManifest.server.version)
  });
  /** Provide a deterministic Git adapter for build identity inspection. */
  const git = (_root, args) => {
    calls.push(args);
    if (args[0] === 'ls-remote') return `${remoteTagObject}\t${tagRef}`;
    if (args[0] === 'fetch') return '';
    if (args[0] === 'rev-parse') {
      if (args[2] === `${tagRef}^{object}`) return localTagObject;
      if (args[2] === `${tagRef}^{commit}`) return peeledCommit;
      if (args[2] === 'HEAD^{commit}') return checkoutCommit;
      if (args[2] === 'refs/remotes/origin/master^{commit}') return masterCommit;
    }
    if (args[0] === 'cat-file' && args[1] === '-t') return tagObjectKind;
    if (args[0] === 'cat-file' && args[1] === '-p') {
      return [
        `object ${tagCommit}`,
        `type ${directTargetType}`,
        `tag ${internalTag}`,
        'tagger Release Bot <release@example.com> 1700000000 +0000',
        '',
        `Release ${releaseTag}`
      ].join('\n');
    }
    if (args[0] === 'merge-base') {
      if (!onMaster) throw new Error('not an ancestor');
      return '';
    }
    if (args[0] === 'rev-list') return [tagCommit, ...parentCommits].join(' ');
    if (args[0] === 'diff-tree') {
      return changedPaths.map((relativePath) => `${changedStatus}\t${relativePath}`).join('\n');
    }
    if (args[0] === 'show') {
      const separator = args[1].indexOf(':');
      const revision = args[1].slice(0, separator);
      const relativePath = args[1].slice(separator + 1);
      const key = Object.entries(preparedReleaseSourcePaths)
        .find(([, candidatePath]) => candidatePath === relativePath)?.[0];
      if (key && revision === parentCommit) return parentSources[key];
      if (key && revision === tagCommit) return targetSources[key];
      if (revision === masterCommit && relativePath === 'shared/release.json') {
        return JSON.stringify({ server: { version: masterVersion } });
      }
    }
    throw new Error(`Unexpected prepared release Git command: ${args.join(' ')}`);
  };
  /** Return the controlled mirror validation result for a candidate fixture. */
  const checkRepositoryFn = async (root, options) => {
    checkCalls.push({ root, options });
    return { manifest: targetManifest, errors: checkErrors };
  };
  return {
    calls,
    checkCalls,
    git,
    checkRepositoryFn,
    releaseTag,
    remoteTagObject,
    tagCommit,
    masterCommit,
    parentCommit
  };
}
test('release checks reject a missing or stale iOS build number', async (t) => {
  const root = await createReleaseFixture(t);
  const appPath = path.join(root, 'mobile', 'app.json');
  const app = await readFixtureJson(root, 'mobile/app.json');
  const manifest = await readFixtureJson(root, 'shared/release.json');

  for (const buildNumber of [undefined, '1', manifest.android.mobile.version_code]) {
    app.expo.ios.buildNumber = buildNumber;
    await writeFile(appPath, JSON.stringify(app));
    const { errors } = await checkRepository(root);
    assert.match(errors.join('\n'), /expo\.ios\.buildNumber/);
  }

  app.expo.ios.buildNumber = String(manifest.android.mobile.version_code);
  await writeFile(appPath, JSON.stringify(app));
  assert.deepEqual((await checkRepository(root)).errors, []);
});

test('semantic versions compare numerically', () => {
  assert.equal(compareSemver('1.10.0', '1.9.9'), 1);
  assert.equal(compareSemver('2.0.0-internal', '2.0.0'), -1);
  assert.equal(compareSemver('2.0.0-internal.10', '2.0.0-internal.2'), 1);
  assert.equal(compareSemver('999999999999999999999.0.0', '999999999999999999998.0.0'), 1);
  assert.equal(compareSemver('2.0.0+build.2', '2.0.0+build.1'), 0);
});

test('server release versions bump strict semantic components without numeric precision loss', () => {
  assert.equal(nextReleaseVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextReleaseVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextReleaseVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(nextReleaseVersion('999999999999999999999.2.3', 'major'), '1000000000000000000000.0.0');
  assert.throws(() => nextReleaseVersion('1.2.3', 'build'), /major, minor, or patch/);
  assert.throws(() => nextReleaseVersion('1.2.3-internal', 'patch'), /Invalid stable release version/);
});

test('diagnostics rollout versions must track the current release and exact OpenAPI enums', () => {
  assert.deepEqual(
    validateClientDiagnosticVersionContract(validManifest, validDiagnosticVersions, validDiagnosticOpenApi),
    []
  );

  const bumpedManifest = structuredClone(validManifest);
  bumpedManifest.server.version = '1.2.4';
  assert.match(
    validateClientDiagnosticVersionContract(bumpedManifest, validDiagnosticVersions, validDiagnosticOpenApi).join('\n'),
    /must start with the current release 1\.2\.4/
  );

  const missingImmediatePrior = structuredClone(validDiagnosticVersions);
  missingImmediatePrior.previous_web_release = '1.2.2';
  missingImmediatePrior.supported_versions.web = ['1.2.3', '1.2.1'];
  assert.match(
    validateClientDiagnosticVersionContract(validManifest, missingImmediatePrior, validDiagnosticOpenApi).join('\n'),
    /retain exactly the reviewed previous_web_release/
  );

  const staleOpenApi = validDiagnosticOpenApi.replace('[2.0.0, 1.5.0]', '[2.0.0]');
  assert.match(
    validateClientDiagnosticVersionContract(validManifest, validDiagnosticVersions, staleOpenApi).join('\n'),
    /OpenAPI client diagnostic android_phone versions do not match/
  );
});

test('diagnostics rollout versions stay bounded, unique, and within native support floors', () => {
  const invalid = structuredClone(validDiagnosticVersions);
  invalid.supported_versions.android_phone = ['2.0.0', '1.4.9', '1.4.9'];
  const errors = validateClientDiagnosticVersionContract(validManifest, invalid, validDiagnosticOpenApi).join('\n');
  assert.match(errors, /must be unique/);
  assert.match(errors, /outside the supported release range/);
});

test('manifest rejects malformed semantic versions', () => {
  const manifest = structuredClone(validManifest);
  manifest.android.mobile.version_name = '2.0.0-..';
  assert.match(validateManifest(manifest).join('\n'), /must be a semantic version/);
});

test('manifest rejects a minimum client version newer than the release', () => {
  const manifest = structuredClone(validManifest);
  manifest.android.wear.minimum_supported_version = '2.1.0';
  assert.match(validateManifest(manifest).join('\n'), /minimum_supported_version cannot exceed/);
});

test('manifest requires a stable native build tag', () => {
  const manifest = structuredClone(validManifest);
  manifest.android.mobile.native_release_tag = 'master';
  assert.match(validateManifest(manifest).join('\n'), /native_release_tag must be a stable native-vMAJOR/);
});

test('manifest requires the native build tag to identify the phone runtime version', () => {
  const manifest = structuredClone(validManifest);
  manifest.android.mobile.native_release_tag = 'native-v1.2.3';
  assert.match(validateManifest(manifest).join('\n'), /native_release_tag must match android\.mobile\.version_name/);
});

test('manifest assigns globally unique phone and Wear version-code lanes', () => {
  const duplicate = structuredClone(validManifest);
  duplicate.android.mobile.version_code = 10;
  assert.match(validateManifest(duplicate).join('\n'), /mobile and Wear version_code values must be globally unique/);

  const wrongLanes = structuredClone(validManifest);
  wrongLanes.android.mobile.version_code = 22;
  wrongLanes.android.wear.version_code = 11;
  const errors = validateManifest(wrongLanes).join('\n');
  assert.match(errors, /mobile\.version_code must be odd/);
  assert.match(errors, /wear\.version_code must be even/);
});

test('historical prepared validation accepts the exact v0.35.0 source-era native identity only in that mode', () => {
  const strictErrors = validateManifest(historicalPreparedV035Manifest).join('\n');
  assert.match(strictErrors, /mobile\.version_code must be odd/);
  assert.match(strictErrors, /mobile and Wear version_code values must be globally unique/);
  assert.match(strictErrors, /native_release_tag must be a stable native-vMAJOR/);
  const unboundHistoricalErrors = validateManifest(
    historicalPreparedV035Manifest,
    { validationMode: 'historical-prepared' }
  ).join('\n');
  assert.match(unboundHistoricalErrors, /Historical prepared release v0\.35\.0 requires source commit 93ff747/);
  assert.match(unboundHistoricalErrors, /mobile\.version_code must be odd/);
  assert.match(unboundHistoricalErrors, /mobile and Wear version_code values must be globally unique/);
  assert.match(unboundHistoricalErrors, /native_release_tag must be a stable native-vMAJOR/);
  assert.deepEqual(
    validateManifest(historicalPreparedV035Manifest, {
      validationMode: 'historical-prepared',
      sourceCommit: HISTORICAL_PREPARED_RELEASE_COMMIT
    }),
    []
  );

  const modernInvalidManifest = structuredClone(historicalPreparedV035Manifest);
  modernInvalidManifest.server.version = '0.35.1';
  modernInvalidManifest.android.mobile.native_release_tag = 'native-v0.2.5';
  const modernErrors = validateManifest(modernInvalidManifest, {
    validationMode: 'historical-prepared',
    sourceCommit: HISTORICAL_PREPARED_RELEASE_COMMIT
  }).join('\n');
  assert.match(modernErrors, /mobile\.version_code must be odd/);
  assert.match(modernErrors, /mobile and Wear version_code values must be globally unique/);
  assert.match(modernErrors, /native_release_tag must match android\.mobile\.version_name/);

  const malformedLegacyTag = structuredClone(historicalPreparedV035Manifest);
  malformedLegacyTag.android.mobile.native_release_tag = 'master';
  assert.match(
    validateManifest(malformedLegacyTag, {
      validationMode: 'historical-prepared',
      sourceCommit: HISTORICAL_PREPARED_RELEASE_COMMIT
    }).join('\n'),
    /must be a stable native-vMAJOR.MINOR.PATCH/
  );
  assert.throws(
    () => validateManifest(historicalPreparedV035Manifest, { validationMode: 'source-era' }),
    /Unknown release validation mode: source-era/
  );
});

test('the recorded v0.35.0 commit is the byte-exact canonical transform of its sole parent', (t) => {
  const objectCheck = spawnSync('git', [
    '--no-replace-objects',
    'cat-file',
    '-e',
    `${HISTORICAL_PREPARED_RELEASE_COMMIT}^{commit}`
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  if (objectCheck.status !== 0) {
    t.skip('The immutable v0.35.0 commit is unavailable in this shallow checkout.');
    return;
  }
  /** Provide a deterministic Git adapter for build identity inspection. */
  const git = (args) => {
    const result = spawnSync('git', ['--no-replace-objects', ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const parentCommit = git(['rev-parse', `${HISTORICAL_PREPARED_RELEASE_COMMIT}^`]).trim();
  const parentSources = Object.fromEntries(
    Object.entries({ ...preparedReleaseSourcePaths, openApi: 'docs/openapi/v1.yaml' }).map(([key, relativePath]) => [
      key,
      git(['show', `${parentCommit}:${relativePath}`])
    ])
  );
  const expectedSources = createServerReleaseReplacements(parentSources, '0.35.0');

  for (const [key, relativePath] of Object.entries({ ...preparedReleaseSourcePaths, openApi: 'docs/openapi/v1.yaml' })) {
    assert.equal(
      git(['show', `${HISTORICAL_PREPARED_RELEASE_COMMIT}:${relativePath}`]),
      expectedSources[key],
      `${relativePath} must be the canonical v0.35.0 transform`
    );
  }
});

test('modern tooling checks, tags, and verifies the exact pre-iOS canonical image source', async (t) => {
  const available = spawnSync('git', ['cat-file', '-e', `${HISTORICAL_PREPARED_RELEASE_COMMIT}^{commit}`], {
    cwd: repositoryRoot, encoding: 'utf8'
  });
  if (available.status !== 0) {
    t.skip('The immutable v0.35.0 source is unavailable in this shallow checkout.');
    return;
  }
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'calibrate-historical-ios-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const root = path.join(temporaryRoot, 'source');
  const clone = spawnSync('git', ['clone', '--shared', '--no-checkout', '--quiet', repositoryRoot, root], {
    encoding: 'utf8'
  });
  assert.equal(clone.status, 0, clone.stderr);
  /** Provide a deterministic Git adapter for build identity inspection. */
  const git = (args) => {
    const result = spawnSync('git', ['--no-replace-objects', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(['update-ref', '--no-deref', 'HEAD', HISTORICAL_PREPARED_RELEASE_COMMIT]);
  for (const relativePath of releaseFixturePaths.map(file => file === 'backend/openapi/v1.yaml' ? 'docs/openapi/v1.yaml' : file)) {
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, git(['show', `${HISTORICAL_PREPARED_RELEASE_COMMIT}:${relativePath}`]));
  }
  assert.equal((await readFixtureJson(root, 'mobile/app.json')).expo.ios, undefined);
  assert.equal((await readFixtureJson(root, 'shared/client-diagnostic-versions.json')).supported_versions.ios, undefined);
  for (const command of ['check', 'tag']) {
    const result = spawnSync(process.execPath, [
      releaseConfigScriptPath, command, '--repository-root', root, '--validation-mode', 'historical-prepared'
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, command === 'tag' ? /v0\.35\.0/ : /Release configuration is consistent/);
  }
  const fixture = createPreparedReleaseGit({
    releaseTag: 'v0.35.0',
    changedPaths: PREPARED_RELEASE_MIRROR_PATHS.map(file => file === 'backend/openapi/v1.yaml' ? 'docs/openapi/v1.yaml' : file).sort(),
    tagCommit: HISTORICAL_PREPARED_RELEASE_COMMIT,
    parentCommit: git(['rev-parse', 'HEAD^']).trim(),
    parentVersion: JSON.parse(git(['show', 'HEAD^:shared/release.json'])).server.version,
    masterVersion: '0.35.0',
    targetManifest: historicalPreparedV035Manifest
  });
  const verified = await verifyPreparedRelease({
    root, releaseTag: 'v0.35.0', expectedCommit: HISTORICAL_PREPARED_RELEASE_COMMIT, publishLatest: true,
    git: (cwd, args) => args[0] === 'show' && !args[1].startsWith(fixture.masterCommit + ':')
      ? git(args) : fixture.git(cwd, args)
  });
  assert.equal(verified.sourceCommit, HISTORICAL_PREPARED_RELEASE_COMMIT);
  for (const options of [
    { validationMode: 'current', sourceCommit: HISTORICAL_PREPARED_RELEASE_COMMIT },
    { validationMode: 'historical-prepared', sourceCommit: 'e'.repeat(40) }
  ]) {
    const errors = (await checkRepository(root, options)).errors.join('\n');
    assert.match(errors, /expo\.ios\.buildNumber/);
    assert.match(errors, /client diagnostic ios/);
  }
  const changedManifest = await readFixtureJson(root, 'shared/release.json');
  changedManifest.android.mobile.version_code = 9;
  await writeFile(path.join(root, 'shared/release.json'), JSON.stringify(changedManifest));
  const changedErrors = (await checkRepository(root, {
    validationMode: 'historical-prepared', sourceCommit: HISTORICAL_PREPARED_RELEASE_COMMIT
  })).errors.join('\n');
  assert.match(changedErrors, /expo\.ios\.buildNumber/);
  assert.match(changedErrors, /client diagnostic ios/);
});

test('manifest rejects version codes above Google Play\'s limit', () => {
  const manifest = structuredClone(validManifest);
  manifest.android.wear.version_code = GOOGLE_PLAY_MAX_VERSION_CODE + 2;
  assert.match(validateManifest(manifest).join('\n'), /cannot exceed Google Play's 2100000000 limit/);
});

test('release metadata is deterministic when source date epoch is supplied', async () => {
  const first = await createReleaseMetadata({
    manifest: validManifest,
    channel: 'internal',
    root: process.cwd(),
    sourceDateEpoch: '1700000000'
  });
  const second = await createReleaseMetadata({
    manifest: validManifest,
    channel: 'internal',
    root: process.cwd(),
    sourceDateEpoch: '1700000000'
  });
  assert.deepEqual(first, second);
  assert.equal(first.generated_at, '2023-11-14T22:13:20.000Z');
});

test('release metadata rejects unknown channels', async () => {
  await assert.rejects(
    createReleaseMetadata({ manifest: validManifest, channel: 'nightly', root: process.cwd() }),
    /Unknown release channel/
  );
});

test('production tag comes from the manifest and must advance', () => {
  assert.equal(getReleaseTag(validManifest, 'v1.2.2'), 'v1.2.3');
  assert.throws(() => getReleaseTag(validManifest, 'v1.2.3'), /must be newer/);
  const prerelease = structuredClone(validManifest);
  prerelease.server.version = '1.2.4-internal';
  assert.throws(() => getReleaseTag(prerelease), /stable server.version/);
});

test('automatic release planning publishes advances, skips an existing version, and rejects regressions', () => {
  assert.deepEqual(getReleasePlan(validManifest, 'v1.2.2'), {
    latest_tag: 'v1.2.2',
    new_tag: 'v1.2.3',
    should_release: true
  });
  assert.deepEqual(getReleasePlan(validManifest, 'v1.2.3'), {
    latest_tag: 'v1.2.3',
    new_tag: 'v1.2.3',
    should_release: false
  });
  assert.throws(() => getReleasePlan(validManifest, 'v1.2.4'), /cannot be older/);
});

test('prepared release verifier binds the exact annotated origin tag to the checkout and canonical candidate', async () => {
  const fixture = createPreparedReleaseGit();
  const result = await verifyPreparedRelease({
    root: repositoryRoot,
    releaseTag: fixture.releaseTag,
    expectedCommit: fixture.tagCommit,
    publishLatest: true,
    git: fixture.git,
    checkRepositoryFn: fixture.checkRepositoryFn
  });

  assert.deepEqual(result, {
    releaseTag: fixture.releaseTag,
    tagObject: fixture.remoteTagObject,
    sourceCommit: fixture.tagCommit,
    parentCommit: fixture.parentCommit,
    masterCommit: fixture.masterCommit,
    currentStableTag: fixture.releaseTag
  });
  assert.deepEqual(fixture.checkCalls, [{
    root: repositoryRoot,
    options: { validationMode: 'historical-prepared' }
  }]);
  assert.ok(fixture.calls.some((args) => (
    args[0] === 'fetch'
    && args.includes('+refs/heads/master:refs/remotes/origin/master')
    && args.includes(`+refs/tags/${fixture.releaseTag}:refs/tags/${fixture.releaseTag}`)
  )));
});

test('candidate-only verification proves canonical bytes before an immutable tag exists', async () => {
  const fixture = createPreparedReleaseGit();
  const result = await verifyPreparedReleaseCandidate({
    root: repositoryRoot,
    releaseTag: fixture.releaseTag,
    expectedCommit: fixture.tagCommit,
    git: fixture.git,
    checkRepositoryFn: fixture.checkRepositoryFn
  });

  assert.equal(result.sourceCommit, fixture.tagCommit);
  assert.equal(fixture.calls.some((args) => args[0] === 'ls-remote'), false);
  assert.equal(fixture.calls.some((args) => args[0] === 'cat-file'), false);
  assert.ok(fixture.calls.some((args) => (
    args[0] === 'fetch'
    && args.includes('+refs/heads/master:refs/remotes/origin/master')
  )));
});

test('pre-branch candidate verification accepts a canonical child of freshly fetched origin/master', async () => {
  const currentMasterCommit = 'd'.repeat(40);
  const fixture = createPreparedReleaseGit({
    masterCommit: currentMasterCommit,
    parentCommit: currentMasterCommit,
    parentCommits: [currentMasterCommit],
    masterVersion: '1.2.2'
  });
  const result = await verifyPreparedReleaseCandidate({
    root: repositoryRoot,
    releaseTag: fixture.releaseTag,
    expectedCommit: fixture.tagCommit,
    publishLatest: true,
    candidateParentCurrentMaster: true,
    git: fixture.git,
    checkRepositoryFn: fixture.checkRepositoryFn
  });

  assert.deepEqual(result, {
    releaseTag: fixture.releaseTag,
    sourceCommit: fixture.tagCommit,
    parentCommit: currentMasterCommit,
    masterCommit: currentMasterCommit,
    currentStableTag: 'v1.2.2'
  });
  assert.equal(fixture.calls.some((args) => args[0] === 'merge-base'), false);
  assert.ok(fixture.calls.some((args) => (
    args[0] === 'fetch'
    && args.includes('+refs/heads/master:refs/remotes/origin/master')
  )));
});

test('pre-branch candidate verification rejects stale parents, wrong commits, and noncanonical bytes', async () => {
  const stale = createPreparedReleaseGit();
  await assert.rejects(
    verifyPreparedReleaseCandidate({
      root: repositoryRoot,
      releaseTag: stale.releaseTag,
      expectedCommit: stale.tagCommit,
      publishLatest: true,
      candidateParentCurrentMaster: true,
      git: stale.git,
      checkRepositoryFn: stale.checkRepositoryFn
    }),
    /parent d{40} does not match current origin\/master c{40}/
  );

  const currentMasterCommit = 'd'.repeat(40);
  const wrongCommit = createPreparedReleaseGit({
    masterCommit: currentMasterCommit,
    parentCommit: currentMasterCommit,
    parentCommits: [currentMasterCommit],
    masterVersion: '1.2.2'
  });
  await assert.rejects(
    verifyPreparedReleaseCandidate({
      root: repositoryRoot,
      releaseTag: wrongCommit.releaseTag,
      expectedCommit: 'e'.repeat(40),
      publishLatest: true,
      candidateParentCurrentMaster: true,
      git: wrongCommit.git,
      checkRepositoryFn: wrongCommit.checkRepositoryFn
    }),
    /checkout b{40} does not match expected commit e{40}/
  );

  const noncanonical = createPreparedReleaseGit({
    masterCommit: currentMasterCommit,
    parentCommit: currentMasterCommit,
    parentCommits: [currentMasterCommit],
    masterVersion: '1.2.2',
    /** Inject unrelated candidate content to test exact-byte rejection. */
    targetSourceMutator(sources) {
      sources.generatedApi += 'export const injected = true;\n';
      return sources;
    }
  });
  await assert.rejects(
    verifyPreparedReleaseCandidate({
      root: repositoryRoot,
      releaseTag: noncanonical.releaseTag,
      expectedCommit: noncanonical.tagCommit,
      publishLatest: true,
      candidateParentCurrentMaster: true,
      git: noncanonical.git,
      checkRepositoryFn: noncanonical.checkRepositoryFn
    }),
    /packages\/api-client\/src\/generated\/v1\.ts does not match the canonical transformation/
  );
});

test('candidate-only verification rejects an older canonical ancestor before tag mutation', async () => {
  const fixture = createPreparedReleaseGit({ masterVersion: '1.2.4' });
  await assert.rejects(
    verifyPreparedReleaseCandidate({
      root: repositoryRoot,
      releaseTag: fixture.releaseTag,
      expectedCommit: fixture.tagCommit,
      publishLatest: true,
      git: fixture.git,
      checkRepositoryFn: fixture.checkRepositoryFn
    }),
    /current origin\/master manifest resolves to v1\.2\.4/
  );
  assert.equal(fixture.calls.some((args) => args[0] === 'ls-remote'), false);
  assert.equal(fixture.calls.some((args) => args[0] === 'cat-file'), false);
});

/** Model protected-master history for workflow authority tests. */
function currentWorkflowGit(fixture, {
  masterParents = [fixture.parentCommit, fixture.tagCommit],
  masterTree = 'e'.repeat(40),
  releaseTree = masterTree
} = {}) {
  return (root, args) => {
    const revision = args.at(-1);
    if (args[0] === 'rev-list' && revision === fixture.masterCommit) {
      return [fixture.masterCommit, ...masterParents].join(' ');
    }
    if (args[0] === 'rev-list' && revision === fixture.tagCommit) {
      return `${fixture.tagCommit} ${fixture.parentCommit}`;
    }
    if (args[0] === 'rev-parse' && args[2] === `${fixture.masterCommit}^{tree}`) {
      return masterTree;
    }
    if (args[0] === 'rev-parse' && args[2] === `${fixture.tagCommit}^{tree}`) {
      return releaseTree;
    }
    if (args[0] === 'checkout') return '';
    return fixture.git(root, args);
  };
}

test('current release workflow credentials accept exact protected master and the canonical Cut merge only', async () => {
  const current = createPreparedReleaseGit({
    masterCommit: 'd'.repeat(40),
    parentCommit: 'd'.repeat(40)
  });
  assert.deepEqual(
    await verifyCurrentReleaseWorkflow({
      root: repositoryRoot,
      workflowSha: current.parentCommit,
      git: current.git
    }),
    {
      mode: 'current-master',
      workflowCommit: current.parentCommit,
      masterCommit: current.parentCommit
    }
  );

  const merged = createPreparedReleaseGit();
  const result = await verifyCurrentReleaseWorkflow({
    root: repositoryRoot,
    workflowSha: merged.parentCommit,
    releaseCommit: merged.tagCommit,
    git: currentWorkflowGit(merged),
    checkRepositoryFn: merged.checkRepositoryFn
  });
  assert.deepEqual(result, {
    mode: 'canonical-release-merge',
    workflowCommit: merged.parentCommit,
    masterCommit: merged.masterCommit,
    releaseCommit: merged.tagCommit,
    releaseTag: merged.releaseTag
  });
  assert.ok(merged.checkCalls.length > 0, 'canonical release bytes must be reconstructed and checked');
  assert.equal(
    merged.calls.filter((args) => args[0] === 'fetch').length,
    1,
    'canonical validation must reuse the exact master ref fetched for the authority graph'
  );

  const direct = createPreparedReleaseGit({ masterCommit: 'b'.repeat(40) });
  const directResult = await verifyCurrentReleaseWorkflow({
    root: repositoryRoot,
    workflowSha: direct.parentCommit,
    releaseCommit: direct.tagCommit,
    git: currentWorkflowGit(direct, { masterParents: [direct.parentCommit] }),
    checkRepositoryFn: direct.checkRepositoryFn
  });
  assert.equal(directResult.mode, 'canonical-release-child');
});

test('current release workflow credentials reject stale ancestry, changed merge trees, and noncanonical children', async () => {
  const stale = createPreparedReleaseGit();
  await assert.rejects(
    verifyCurrentReleaseWorkflow({
      root: repositoryRoot,
      workflowSha: stale.parentCommit,
      releaseCommit: stale.tagCommit,
      git: currentWorkflowGit(stale, { masterParents: ['f'.repeat(40)] }),
      checkRepositoryFn: stale.checkRepositoryFn
    }),
    /not the exact canonical Cut release merge/
  );

  const changedTree = createPreparedReleaseGit();
  await assert.rejects(
    verifyCurrentReleaseWorkflow({
      root: repositoryRoot,
      workflowSha: changedTree.parentCommit,
      releaseCommit: changedTree.tagCommit,
      git: currentWorkflowGit(changedTree, {
        masterTree: 'e'.repeat(40),
        releaseTree: 'f'.repeat(40)
      }),
      checkRepositoryFn: changedTree.checkRepositoryFn
    }),
    /tree differs from the canonical release tree/
  );

  const noncanonical = createPreparedReleaseGit({
    /** Inject unrelated candidate content to test exact-byte rejection. */
    targetSourceMutator(sources) {
      sources.rootPackage += '{"injected":true}\n';
      return sources;
    }
  });
  await assert.rejects(
    verifyCurrentReleaseWorkflow({
      root: repositoryRoot,
      workflowSha: noncanonical.parentCommit,
      releaseCommit: noncanonical.tagCommit,
      git: currentWorkflowGit(noncanonical),
      checkRepositoryFn: noncanonical.checkRepositoryFn
    }),
    /package\.json does not match the canonical transformation/
  );
});

test('prepared release verifier rejects synchronized but noncanonical payloads inside allowed mirrors', async () => {
  const cases = [
    {
      path: 'package.json',
      /** Introduce one deliberate fixture violation for fail-closed validation. */
      mutate(sources) {
        const value = JSON.parse(sources.rootPackage);
        value.scripts = { postinstall: 'node scripts/unreviewed.mjs' };
        sources.rootPackage = `${JSON.stringify(value, null, 2)}\n`;
        return sources;
      }
    },
    {
      path: 'package-lock.json',
      /** Introduce one deliberate fixture violation for fail-closed validation. */
      mutate(sources) {
        const value = JSON.parse(sources.rootLock);
        value.packages['node_modules/unreviewed'] = { version: '1.0.0' };
        sources.rootLock = `${JSON.stringify(value, null, 2)}\n`;
        return sources;
      }
    },
    {
      path: 'backend/openapi/v1.yaml',
      /** Introduce one deliberate fixture violation for fail-closed validation. */
      mutate(sources) {
        sources.openApi += 'x-unreviewed-release-change: true\n';
        return sources;
      }
    },
    {
      path: 'packages/api-client/src/generated/v1.ts',
      /** Introduce one deliberate fixture violation for fail-closed validation. */
      mutate(sources) {
        sources.generatedApi += 'export const unreviewed = true;\n';
        return sources;
      }
    }
  ];

  for (const testCase of cases) {
    const fixture = createPreparedReleaseGit({ targetSourceMutator: testCase.mutate });
    await assert.rejects(
      verifyPreparedRelease({
        root: repositoryRoot,
        releaseTag: fixture.releaseTag,
        expectedCommit: fixture.tagCommit,
        git: fixture.git,
        checkRepositoryFn: fixture.checkRepositoryFn
      }),
      new RegExp(`Prepared release mirror ${testCase.path.replaceAll('.', '\\.')}`)
    );
  }
});

test('prepared release verifier rejects lightweight, indirect, misnamed, and mismatched tag identities', async () => {
  const cases = [
    { options: { tagObjectKind: 'commit' }, message: /must be an annotated tag/ },
    { options: { directTargetType: 'tag' }, message: /must point directly to a commit/ },
    { options: { internalTag: 'v9.9.9' }, message: /object names v9\.9\.9, not v1\.2\.3/ },
    { options: { peeledCommit: 'e'.repeat(40) }, message: /does not peel to its direct commit target/ },
    { options: { localTagObject: 'e'.repeat(40) }, message: /does not match its exact object on origin/ }
  ];

  for (const { options, message } of cases) {
    const fixture = createPreparedReleaseGit(options);
    await assert.rejects(
      verifyPreparedRelease({
        root: repositoryRoot,
        releaseTag: fixture.releaseTag,
        expectedCommit: fixture.tagCommit,
        git: fixture.git,
        checkRepositoryFn: fixture.checkRepositoryFn
      }),
      message
    );
  }
});

test('prepared release verifier rejects off-master, moved, multi-parent, and extra-file candidates', async () => {
  const cases = [
    { options: { onMaster: false }, message: /not on current origin\/master history/ },
    {
      options: { parentCommits: ['d'.repeat(40), 'e'.repeat(40)] },
      message: /must have exactly one parent/
    },
    {
      options: { changedPaths: [...PREPARED_RELEASE_MIRROR_PATHS, 'scripts/unreviewed-release.mjs'] },
      message: /must change exactly/
    },
    { options: { changedStatus: 'A' }, message: /only modifications/ },
    { options: { parentVersion: '1.2.3' }, message: /must be an exact patch, minor, or major advance/ }
  ];

  for (const { options, message } of cases) {
    const fixture = createPreparedReleaseGit(options);
    await assert.rejects(
      verifyPreparedRelease({
        root: repositoryRoot,
        releaseTag: fixture.releaseTag,
        expectedCommit: fixture.tagCommit,
        git: fixture.git,
        checkRepositoryFn: fixture.checkRepositoryFn
      }),
      message
    );
  }

  const moved = createPreparedReleaseGit();
  await assert.rejects(
    verifyPreparedRelease({
      root: repositoryRoot,
      releaseTag: moved.releaseTag,
      expectedCommit: 'e'.repeat(40),
      git: moved.git,
      checkRepositoryFn: moved.checkRepositoryFn
    }),
    /not expected commit/
  );
});

test('latest eligibility comes from origin/master and ignores poisoned high off-branch tags', async () => {
  const current = createPreparedReleaseGit();
  await verifyPreparedRelease({
    root: repositoryRoot,
    releaseTag: current.releaseTag,
    expectedCommit: current.tagCommit,
    publishLatest: true,
    git: current.git,
    checkRepositoryFn: current.checkRepositoryFn
  });
  const remoteQueries = current.calls.filter((args) => args[0] === 'ls-remote');
  assert.deepEqual(remoteQueries, [[
    'ls-remote',
    '--tags',
    '--refs',
    'origin',
    `refs/tags/${current.releaseTag}`
  ]]);
  assert.equal(current.calls.some((args) => args[0] === 'tag' && args[1] === '--list'), false);

  const stale = createPreparedReleaseGit({ masterVersion: '1.2.4' });
  await assert.rejects(
    verifyPreparedRelease({
      root: repositoryRoot,
      releaseTag: stale.releaseTag,
      expectedCommit: stale.tagCommit,
      publishLatest: true,
      git: stale.git,
      checkRepositoryFn: stale.checkRepositoryFn
    }),
    /current origin\/master manifest resolves to v1\.2\.4/
  );

  const poisonedManifest = structuredClone(validManifest);
  poisonedManifest.server.version = '9.9.9';
  const poisoned = createPreparedReleaseGit({
    releaseTag: 'v9.9.9',
    internalTag: 'v9.9.9',
    targetManifest: poisonedManifest,
    parentVersion: '9.9.8',
    onMaster: false
  });
  await assert.rejects(
    verifyPreparedRelease({
      root: repositoryRoot,
      releaseTag: poisoned.releaseTag,
      expectedCommit: poisoned.tagCommit,
      publishLatest: true,
      git: poisoned.git,
      checkRepositoryFn: poisoned.checkRepositoryFn
    }),
    /not on current origin\/master history/
  );
});

for (const bump of ['patch', 'minor', 'major']) {
  test(`release preparation synchronizes every server/web mirror for a ${bump} bump`, async (t) => {
    const root = await createReleaseFixture(t);
    const manifestBefore = await readFixtureJson(root, 'shared/release.json');
    const currentVersion = manifestBefore.server.version;
    const expectedVersion = nextReleaseVersion(currentVersion, bump);
    const nativeBefore = manifestBefore.android;

    assert.equal(
      await prepareServerRelease({ root, bump, latestTag: `v${currentVersion}` }),
      expectedVersion
    );

    const manifest = await readFixtureJson(root, 'shared/release.json');
    const diagnostics = await readFixtureJson(root, 'shared/client-diagnostic-versions.json');
    const rootPackage = await readFixtureJson(root, 'package.json');
    const rootLock = await readFixtureJson(root, 'package-lock.json');
    const backendPackage = await readFixtureJson(root, 'backend/package.json');
    const backendLock = await readFixtureJson(root, 'backend/package-lock.json');
    const openApi = await readFile(path.join(root, 'backend/openapi/v1.yaml'), 'utf8');
    const generatedApi = await readFile(path.join(root, 'packages/api-client/src/generated/v1.ts'), 'utf8');

    assert.equal(manifest.server.version, expectedVersion);
    assert.deepEqual(manifest.android, nativeBefore);
    assert.equal(rootPackage.version, expectedVersion);
    assert.equal(rootLock.version, expectedVersion);
    assert.equal(rootLock.packages[''].version, expectedVersion);
    assert.equal(backendPackage.version, expectedVersion);
    assert.equal(backendLock.version, expectedVersion);
    assert.equal(backendLock.packages[''].version, expectedVersion);
    assert.equal(diagnostics.previous_web_release, currentVersion);
    assert.deepEqual(diagnostics.supported_versions.web, [expectedVersion, currentVersion]);
    assert.ok(openApi.includes(`version: { enum: [${expectedVersion}, ${currentVersion}]`));
    assert.ok(generatedApi.includes(`version?: "${expectedVersion}" | "${currentVersion}";`));
    assert.deepEqual((await checkRepository(root)).errors, []);
  });
}

test('native version-code allocation advances into permanent odd phone and even Wear lanes', () => {
  assert.deepEqual(getNextNativeVersionCodes(validManifest), {
    mobileVersionCode: 23,
    wearVersionCode: 24
  });
  const exhausted = structuredClone(validManifest);
  exhausted.android.mobile.version_code = GOOGLE_PLAY_MAX_VERSION_CODE - 1;
  exhausted.android.wear.version_code = GOOGLE_PLAY_MAX_VERSION_CODE;
  assert.throws(() => getNextNativeVersionCodes(exhausted), /cannot exceed Google Play's 2100000000 limit/);
  assert.deepEqual(getNextNativeVersionCodes(validManifest, 30), { mobileVersionCode: 31, wearVersionCode: 32 });
  assert.throws(() => getNextNativeVersionCodes(validManifest, -1), /minimum|floor|nonnegative/i);
});

for (const openApiPath of ['backend/openapi/v1.yaml', 'docs/openapi/v1.yaml']) {
test(`combined native/server candidates preserve exact bytes and code floors with ${openApiPath}`, async (t) => {
  const root = await createReleaseFixture(t);
  const originals = Object.fromEntries(await Promise.all(releaseFixturePaths.map(async (file) => [file, await readFile(path.join(root, file), 'utf8')])));
  const source = 'a'.repeat(40), candidate = 'b'.repeat(40);
  const before = JSON.parse(originals['shared/release.json']);
  await prepareNativeRelease({ root, bump: 'patch', minimumCode: 30 });
  await prepareServerRelease({ root, bump: 'patch', latestTag: `v${before.server.version}` });
  const prepared = await readFixtureJson(root, 'shared/release.json');
  if (openApiPath !== 'backend/openapi/v1.yaml') {
    originals[openApiPath] = originals['backend/openapi/v1.yaml'];
    await mkdir(path.join(root, 'docs/openapi'), { recursive: true });
    await rename(path.join(root, 'backend/openapi/v1.yaml'), path.join(root, openApiPath));
  }
  const paths = [...new Set([...PREPARED_RELEASE_MIRROR_PATHS, ...Object.values(NATIVE_RELEASE_FILE_PATHS)])]
    .map(file => file === 'backend/openapi/v1.yaml' ? openApiPath : file).sort();
  const candidateBytes = Object.fromEntries(await Promise.all(paths.map(async (file) => [file, await readFile(path.join(root, file), 'utf8')])));
  /** Model protected ancestry while retaining exact real fixture file bytes. */
  const git = (_root, args) => {
    if (args[0] === 'fetch' || args[0] === 'merge-base') return '';
    if (args[0] === 'rev-parse') return candidate;
    if (args[0] === 'rev-list') return `${candidate} ${source}`;
    if (args[0] === 'diff-tree') return paths.map(file => `M\t${file}`).join('\n');
    if (args[0] === 'show') { const [revision, file] = args[1].split(':'); return revision === source ? originals[file] : candidateBytes[file]; }
    throw new Error(`Unexpected Git fixture: ${args}`);
  };
  const options = { root, releaseTag: `v${prepared.server.version}`, expectedCommit: candidate, git, gitRaw: git };
  await verifyPreparedReleaseCandidate(options);
  assert.equal(prepared.android.mobile.version_code, 31);
  candidateBytes['wear/app/build.gradle.kts'] += '\n// unreviewed source change\n';
  await assert.rejects(verifyPreparedReleaseCandidate(options), /canonical transformation/);
});
}

test('published native tag verification fetches an exact remote tag missing locally', () => {
  const expectedTag = 'native-v0.2.6';
  const tagCommit = 'b'.repeat(40);
  const { calls, git, tagRef } = createNativeTagGit({ expectedTag, localTagObject: null, tagCommit });
  const attestationCalls = [];
  /** Inspect the historical tag verification call without private signing material. */
  const verifyTagAttestation = (options) => {
    attestationCalls.push(options);
    return { tagObject: 'a'.repeat(40) };
  };

  const result = verifyPublishedNativeReleaseTag({
    root: repositoryRoot,
    expectedTag,
    git,
    verifyTagAttestation
  });

  assert.equal(result.latestTag, expectedTag);
  assert.equal(result.fetched, true);
  assert.equal(result.trustSetCommit, 'c'.repeat(40));
  assert.ok(calls.some((args) => (
    args[0] === 'fetch'
    && args[2] === 'origin'
    && args[3] === `${tagRef}:${tagRef}`
  )));
  assert.equal(attestationCalls.length, 1);
  assert.deepEqual(attestationCalls[0], {
    repositoryRoot,
    tag: expectedTag,
    expectedCommit: tagCommit,
    allowedSigners: currentAllowedSigners
  });
  assert.ok(calls.some((args) => (
    args[0] === 'show'
    && args[1] === `${result.trustSetCommit}:${nativeTagAllowedSignersRepositoryPath}`
  )));
});

test('published native tag verification rejects a local-only tag', () => {
  const expectedTag = 'native-v0.2.6';
  const { calls, git } = createNativeTagGit({ expectedTag, remoteTagObject: null });

  assert.throws(
    () => verifyPublishedNativeReleaseTag({ root: repositoryRoot, expectedTag, git }),
    /native-v0\.2\.6 is not published on origin/
  );
  assert.equal(calls.some((args) => args[0] === 'fetch'), false);
});

test('published native tag verification rejects a local tag with a different published object', () => {
  const expectedTag = 'native-v0.2.6';
  const { git } = createNativeTagGit({
    expectedTag,
    remoteTagObject: 'a'.repeat(40),
    localTagObject: 'd'.repeat(40)
  });

  assert.throws(
    () => verifyPublishedNativeReleaseTag({ root: repositoryRoot, expectedTag, git }),
    /does not match the published tag object/
  );
});

test('published native tag verification binds the signed attestation to the exact origin object', () => {
  const expectedTag = 'native-v0.2.6';
  const { git } = createNativeTagGit({ expectedTag, remoteTagObject: 'a'.repeat(40) });

  assert.throws(
    () => verifyPublishedNativeReleaseTag({
      root: repositoryRoot,
      expectedTag,
      git,
      verifyTagAttestation: () => ({ tagObject: 'd'.repeat(40) })
    }),
    /not the exact object a{40} published on origin/
  );
});

test('published native tag verification rejects a remote tag outside master history', () => {
  const expectedTag = 'native-v0.2.6';
  const { git } = createNativeTagGit({ expectedTag, tagOnPublishedBranch: false });

  assert.throws(
    () => verifyPublishedNativeReleaseTag({ root: repositoryRoot, expectedTag, git }),
    /native-v0\.2\.6 is not on origin\/master history/
  );
});

test('published native tag verification fails closed when signed attestation fails', () => {
  const expectedTag = 'native-v0.2.6';
  const { git } = createNativeTagGit({ expectedTag });

  assert.throws(
    () => verifyPublishedNativeReleaseTag({
      root: repositoryRoot,
      expectedTag,
      git,
      verifyTagAttestation: () => {
        throw new Error('wrong signing key');
      }
    }),
    (error) => {
      assert.match(error.message, /failed signed attestation verification/);
      assert.match(error.cause.message, /wrong signing key/);
      return true;
    }
  );
});

test('published native tag verification applies current origin trust revocation instead of stale local signers', async (t) => {
  const root = await createReleaseFixture(t);
  const staleAllowedSigners = nativeTagAllowedSigner(1);
  const revokedCurrentAllowedSigners = nativeTagAllowedSigner(2);
  const localTrustPath = path.join(root, nativeTagAllowedSignersRepositoryPath);
  await mkdir(path.dirname(localTrustPath), { recursive: true });
  await writeFile(localTrustPath, staleAllowedSigners);
  const { git } = createNativeTagGit({ trustSetSource: revokedCurrentAllowedSigners });
  let attestationAllowedSigners = null;

  assert.throws(
    () => verifyPublishedNativeReleaseTag({
      root,
      expectedTag: 'native-v0.2.6',
      git,
      verifyTagAttestation: ({ allowedSigners }) => {
        attestationAllowedSigners = allowedSigners;
        throw new Error('the tag signer was revoked on current master');
      }
    }),
    (error) => {
      assert.match(error.message, /failed signed attestation verification/);
      assert.match(error.cause.message, /revoked on current master/);
      return true;
    }
  );
  assert.equal(await readFile(localTrustPath, 'utf8'), staleAllowedSigners);
  assert.equal(attestationAllowedSigners, revokedCurrentAllowedSigners);
});

test('release-config check and tag accept an explicit repository root', async (t) => {
  const root = await createReleaseFixture(t);
  const manifest = await readFixtureJson(root, 'shared/release.json');

  const check = spawnSync(process.execPath, [
    releaseConfigScriptPath,
    'check',
    '--repository-root',
    root
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Release configuration is consistent/);

  const tag = spawnSync(process.execPath, [
    releaseConfigScriptPath,
    'tag',
    '--repository-root',
    root
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(tag.status, 0, tag.stderr);
  assert.equal(tag.stdout.trim(), `v${manifest.server.version}`);
});

test('historical-prepared validation requires the exact v0.35.0 mirrors and exact source commit', async (t) => {
  const root = await createReleaseFixture(t);
  await useHistoricalPreparedV035Mirrors(root);

  for (const command of ['check', 'tag']) {
    const unbound = spawnSync(process.execPath, [
      releaseConfigScriptPath,
      command,
      '--repository-root',
      root,
      '--validation-mode',
      'historical-prepared'
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.notEqual(unbound.status, 0, `Expected unbound historical ${command} to fail closed.`);
    assert.match(unbound.stderr, /Historical prepared release v0\.35\.0 requires source commit 93ff747/);
    assert.match(unbound.stderr, /mobile\.version_code must be odd/);
    assert.match(unbound.stderr, /mobile and Wear version_code values must be globally unique/);
    assert.match(unbound.stderr, /native_release_tag must be a stable native-vMAJOR/);
  }

  const sourceBound = await checkRepository(root, {
    validationMode: 'historical-prepared',
    sourceCommit: HISTORICAL_PREPARED_RELEASE_COMMIT
  });
  assert.deepEqual(sourceBound.errors, []);
  assert.equal(getReleaseTag(sourceBound.manifest), 'v0.35.0');
});

test('historical-prepared check and tag reject a mirror-consistent modern invalid native identity', async (t) => {
  const root = await createReleaseFixture(t);
  await useInvalidModernNativeMirrors(root);

  for (const command of ['check', 'tag']) {
    const result = spawnSync(process.execPath, [
      releaseConfigScriptPath,
      command,
      '--repository-root',
      root,
      '--validation-mode',
      'historical-prepared'
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `Expected historical ${command} to keep current native policy strict.`);
    assert.match(result.stderr, /mobile\.version_code must be odd/);
    assert.match(result.stderr, /mobile and Wear version_code values must be globally unique/);
    assert.match(result.stderr, /native_release_tag must match android\.mobile\.version_name/);
  }
});

test('historical mirrors stay frozen after paired native preparation extends diagnostics', async (t) => {
  const root = await createReleaseFixture(t);
  await prepareNativeRelease({ root, bump: 'patch' });
  await prepareNativeRelease({ root, bump: 'patch' });
  await useHistoricalPreparedV035Mirrors(root);
  const result = await checkRepository(root, {
    validationMode: 'historical-prepared', sourceCommit: HISTORICAL_PREPARED_RELEASE_COMMIT
  });
  assert.deepEqual(result.errors, []);
});

test('release-config rejects unknown, duplicate, incomplete, and write-command repository-root options', () => {
  const cases = [
    {
      args: ['check', '--unknown', 'value'],
      message: /Unknown argument for check: --unknown/
    },
    {
      args: ['check', '--repository-root', repositoryRoot, '--repository-root', repositoryRoot],
      message: /Duplicate argument for check: --repository-root/
    },
    {
      args: ['check', '--repository-root'],
      message: /--repository-root requires a value/
    },
    {
      args: ['prepare', '--repository-root', repositoryRoot],
      message: /Unknown argument for prepare: --repository-root/
    },
    {
      args: ['check', '--validation-mode', 'source-era'],
      message: /Unknown release validation mode: source-era/
    },
    {
      args: ['prepare', '--validation-mode', 'historical-prepared'],
      message: /Unknown argument for prepare: --validation-mode/
    },
    {
      args: [
        'verify-prepared-candidate',
        '--release-tag',
        'v1.2.3',
        '--expected-commit',
        'b'.repeat(40),
        '--publish-latest',
        'true',
        '--candidate-parent-current-master',
        'yes'
      ],
      message: /--candidate-parent-current-master must be true or false/
    },
    {
      args: ['verify-prepared-candidate', '--candidate-parent-current-master'],
      message: /--candidate-parent-current-master requires a value/
    },
    {
      args: ['verify-prepared', '--candidate-parent-current-master', 'true'],
      message: /Unknown argument for verify-prepared: --candidate-parent-current-master/
    }
  ];

  for (const { args, message } of cases) {
    const result = spawnSync(process.execPath, [releaseConfigScriptPath, ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0, `Expected ${args.join(' ')} to fail.`);
    assert.match(result.stderr, message);
  }
});

test('native release preparation synchronizes paired identities and every checked mirror', async (t) => {
  const root = await createReleaseFixture(t);
  const manifestBefore = await readFixtureJson(root, 'shared/release.json');
  const currentVersion = manifestBefore.android.mobile.version_name;
  const expectedVersion = nextReleaseVersion(currentVersion, 'patch');
  const expectedCodes = getNextNativeVersionCodes(manifestBefore);
  const generatedGradlePath = path.join(root, 'mobile', 'android', 'app', 'build.gradle');
  await mkdir(path.dirname(generatedGradlePath), { recursive: true });
  await writeFile(generatedGradlePath, [
    'android {',
    '  defaultConfig {',
    `    applicationId "${manifestBefore.android.application_id}"`,
    `    versionCode ${manifestBefore.android.mobile.version_code}`,
    `    versionName "${currentVersion}"`,
    '  }',
    '}',
    ''
  ].join('\n'));

  assert.deepEqual(
    await prepareNativeRelease({
      root,
      bump: 'patch',
      verifyNativeReleaseTag: acceptExpectedNativeReleaseTag
    }),
    {
      version_name: expectedVersion,
      mobile_version_code: expectedCodes.mobileVersionCode,
      wear_version_code: expectedCodes.wearVersionCode,
      native_release_tag: `native-v${expectedVersion}`
    }
  );

  const manifest = await readFixtureJson(root, 'shared/release.json');
  const diagnostics = await readFixtureJson(root, 'shared/client-diagnostic-versions.json');
  const rootLock = await readFixtureJson(root, 'package-lock.json');
  const mobilePackage = await readFixtureJson(root, 'mobile/package.json');
  const mobileApp = await readFixtureJson(root, 'mobile/app.json');
  const pairingPackage = await readFixtureJson(root, 'mobile/modules/wear-pairing/package.json');
  const pairingGradle = await readFile(
    path.join(root, 'mobile/modules/wear-pairing/android/build.gradle'),
    'utf8'
  );
  const wearGradle = await readFile(path.join(root, 'wear/app/build.gradle.kts'), 'utf8');
  const generatedGradle = await readFile(generatedGradlePath, 'utf8');
  const openApi = await readFile(path.join(root, 'backend/openapi/v1.yaml'), 'utf8');
  const generatedApi = await readFile(path.join(root, 'packages/api-client/src/generated/v1.ts'), 'utf8');

  assert.equal(manifest.android.mobile.version_name, expectedVersion);
  assert.equal(manifest.android.mobile.version_code, expectedCodes.mobileVersionCode);
  assert.equal(manifest.android.mobile.native_release_tag, `native-v${expectedVersion}`);
  assert.equal(manifest.android.wear.version_name, expectedVersion);
  assert.equal(manifest.android.wear.version_code, expectedCodes.wearVersionCode);
  assert.equal(mobilePackage.version, expectedVersion);
  assert.equal(mobileApp.expo.version, expectedVersion);
  assert.equal(mobileApp.expo.android.versionCode, expectedCodes.mobileVersionCode);
  assert.equal(mobileApp.expo.ios.buildNumber, String(expectedCodes.mobileVersionCode));
  assert.equal(mobileApp.expo.extra.calibrate.nativeReleaseTag, `native-v${expectedVersion}`);
  assert.equal(pairingPackage.version, expectedVersion);
  assert.equal(rootLock.packages.mobile.version, expectedVersion);
  assert.equal(rootLock.packages['mobile/modules/wear-pairing'].version, expectedVersion);
  assert.deepEqual(diagnostics.supported_versions.android_phone.slice(0, 2), [expectedVersion, currentVersion]);
  assert.deepEqual(diagnostics.supported_versions.wear_os.slice(0, 2), [expectedVersion, currentVersion]);
  assert.match(pairingGradle, new RegExp(`versionCode ${expectedCodes.mobileVersionCode}`));
  assert.match(pairingGradle, new RegExp(`versionName '${expectedVersion.replaceAll('.', '\\.')}'`));
  assert.match(wearGradle, new RegExp(`versionCode = ${expectedCodes.wearVersionCode}`));
  assert.match(wearGradle, new RegExp(`versionName = "${expectedVersion.replaceAll('.', '\\.')}"`));
  assert.match(generatedGradle, new RegExp(`versionCode ${expectedCodes.mobileVersionCode}`));
  assert.match(generatedGradle, new RegExp(`versionName "${expectedVersion.replaceAll('.', '\\.')}"`));
  assert.ok(openApi.includes(`platform: { const: android_phone }, version: { enum: [${expectedVersion},`));
  assert.ok(openApi.includes(`platform: { const: wear_os }, version: { enum: [${expectedVersion},`));
  assert.ok(generatedApi.includes(`platform?: "android_phone";`));
  assert.deepEqual(diagnostics.supported_versions.ios.slice(0, 2), [expectedVersion, currentVersion]);
  assert.ok(openApi.includes(`const: ios }, version: { enum: [${diagnostics.supported_versions.ios.join(', ')}]`));
  const iosBlock = generatedApi.slice(generatedApi.indexOf('platform?: "ios";')).split('platform?: "wear_os";')[0];
  assert.ok(iosBlock.includes(`version?: "${expectedVersion}" | "${currentVersion}"`));
  assert.ok(generatedApi.includes(`version?: "${expectedVersion}" | "${currentVersion}"`));
  assert.deepEqual((await checkRepository(root)).errors, []);
});

test('modern rehearsal overrides satisfy strict release checks for both native roles and iOS', async (t) => {
  const root = await createReleaseFixture(t);
  for (const phoneCode of [1000001, 1000003]) {
    overrideCheckoutVersions(root, phoneCode);
    const checked = await checkRepository(root);
    assert.deepEqual(checked.errors, []);
    assert.equal(checked.manifest.android.mobile.version_code, phoneCode);
    assert.equal(checked.manifest.android.wear.version_code, phoneCode + 1);
    assert.equal((await readFixtureJson(root, 'mobile/app.json')).expo.ios.buildNumber, String(phoneCode));
  }
});

test('native preparation rolls back every Android, iOS, Wear, and diagnostic mirror after a late validation failure', async (t) => {
  const root = await createReleaseFixture(t);
  const trackedMirrors = releaseFixturePaths.filter((file) => file !== 'mobile/eas.json');
  const originals = await Promise.all(trackedMirrors.map((file) => readFile(path.join(root, file), 'utf8')));
  await assert.rejects(prepareNativeRelease({
    root, bump: 'patch',
    verifyNativeReleaseTag: async ({ expectedTag }) => {
      // Change an external validation input after the initial check, so the failure occurs after mirror writes.
      const eas = await readFixtureJson(root, 'mobile/eas.json');
      eas.build.internal.channel = 'invalid-channel';
      await writeFile(path.join(root, 'mobile/eas.json'), JSON.stringify(eas));
      return { latestTag: expectedTag };
    }
  }), /Prepared native release configuration is inconsistent/);
  for (const [index, file] of trackedMirrors.entries()) {
    assert.equal(await readFile(path.join(root, file), 'utf8'), originals[index], `${file} must roll back byte-for-byte`);
  }
});

test('native release preparation refuses an untagged current release without changing files', async (t) => {
  const root = await createReleaseFixture(t);
  const manifestPath = path.join(root, 'shared/release.json');
  const before = await readFile(manifestPath, 'utf8');

  await assert.rejects(
    prepareNativeRelease({
      root,
      bump: 'patch',
      verifyNativeReleaseTag: () => ({ latestTag: null })
    }),
    /Cannot prepare another native release until native-v.*published/
  );
  assert.equal(await readFile(manifestPath, 'utf8'), before);
});

test('native release preparation rejects ambiguous generated Gradle values before writing mirrors', async (t) => {
  const root = await createReleaseFixture(t);
  const manifest = await readFixtureJson(root, 'shared/release.json');
  const manifestPath = path.join(root, 'shared/release.json');
  const before = await readFile(manifestPath, 'utf8');
  const generatedGradlePath = path.join(root, 'mobile', 'android', 'app', 'build.gradle');
  await mkdir(path.dirname(generatedGradlePath), { recursive: true });
  await writeFile(generatedGradlePath, [
    `applicationId "${manifest.android.application_id}"`,
    `versionCode ${manifest.android.mobile.version_code}`,
    `versionCode ${manifest.android.mobile.version_code}`,
    `versionName "${manifest.android.mobile.version_name}"`,
    ''
  ].join('\n'));

  await assert.rejects(
    prepareNativeRelease({
      root,
      bump: 'patch',
      verifyNativeReleaseTag: acceptExpectedNativeReleaseTag
    }),
    /generated mobile versionCode must contain exactly one/
  );
  assert.equal(await readFile(manifestPath, 'utf8'), before);
});

test('release preparation rejects a pending manifest release without changing files', async (t) => {
  const root = await createReleaseFixture(t);
  const manifestPath = path.join(root, 'shared/release.json');
  const before = await readFile(manifestPath, 'utf8');
  const diagnostics = await readFixtureJson(root, 'shared/client-diagnostic-versions.json');

  await assert.rejects(
    prepareServerRelease({ root, bump: 'patch', latestTag: `v${diagnostics.previous_web_release}` }),
    /already ahead.*Publish the pending release/
  );
  assert.equal(await readFile(manifestPath, 'utf8'), before);
});

test('release preparation rejects stale mirrors before making any writes', async (t) => {
  const root = await createReleaseFixture(t);
  const lockPath = path.join(root, 'package-lock.json');
  const lock = await readFixtureJson(root, 'package-lock.json');
  lock.packages[''].version = '0.14.0';
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const manifestPath = path.join(root, 'shared/release.json');
  const currentVersion = (await readFixtureJson(root, 'shared/release.json')).server.version;
  const before = await readFile(manifestPath, 'utf8');

  await assert.rejects(
    prepareServerRelease({ root, bump: 'patch', latestTag: `v${currentVersion}` }),
    new RegExp(`root package version.*expected "${currentVersion.replaceAll('.', '\\.')}"`)
  );
  assert.equal(await readFile(manifestPath, 'utf8'), before);
});


test('local internal preparation advances all native mirrors without a tag or changing the server', async (t) => {
  const root = await createReleaseFixture(t);
  const before = await readFixtureJson(root, 'shared/release.json');
  const result = await prepareLocalInternalNativeRelease({ root, bump: 'patch' });
  const after = await readFixtureJson(root, 'shared/release.json');
  assert.equal(result.version_name, nextReleaseVersion(before.android.mobile.version_name, 'patch'));
  assert.equal(after.android.mobile.version_code % 2, 1);
  assert.equal(after.android.wear.version_code, after.android.mobile.version_code + 1);
  assert.deepEqual(after.server, before.server);
  assert.deepEqual((await checkRepository(root)).errors, []);
  await assert.rejects(prepareNativeRelease({ root, bump: 'patch', verifyNativeReleaseTag: () => { throw new Error('No signed tag'); } }), /No signed tag/);
});


test('native preparation allocates the next pair without a signed-tag prerequisite', async (t) => {
  const root = await createReleaseFixture(t);
  const before = JSON.parse(await readFile(path.join(root, 'shared/release.json'), 'utf8'));
  await prepareNativeRelease({ root, bump: 'patch' });
  const after = JSON.parse(await readFile(path.join(root, 'shared/release.json'), 'utf8'));
  assert.equal(after.android.mobile.version_code, before.android.wear.version_code + 1);
  assert.equal(after.android.wear.version_code, after.android.mobile.version_code + 1);
});
