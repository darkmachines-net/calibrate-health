/** Repository release tooling for native release build. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DISTRIBUTION_URL_PROPERTY as NATIVE_RELEASE_GRADLE_DISTRIBUTION_URL_PROPERTY,
  NATIVE_RELEASE_GRADLE_DISTRIBUTION_SHA256,
  NATIVE_RELEASE_GRADLE_DISTRIBUTION_URL,
  NATIVE_RELEASE_GRADLE_VERSION,
  NATIVE_RELEASE_GRADLE_WRAPPER_JAR_SHA256
} from '../mobile/plugins/nativeReleaseGradleWrapper.js';
import { resolveExpoUpdateBuildConfig, writeNativeOtaBaseline } from './native-ota-contract.mjs';
import {
  NATIVE_RELEASE_APPLICATION_ID,
  NATIVE_RELEASE_ARTIFACT_CONTRACTS
} from './native-release-evidence.mjs';

export const REQUIRED_SIGNING_ENV = Object.freeze([
  'CALIBRATE_ANDROID_SIGNING_STORE_FILE',
  'CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD',
  'CALIBRATE_ANDROID_SIGNING_KEY_ALIAS',
  'CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD'
]);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

// Expo SDK 57 release lint can exceed the generated project's 512 MiB metaspace cap.
export const RELEASE_GRADLE_JVM_ARGS = '-Xmx4096m -XX:MaxMetaspaceSize=1536m -Dfile.encoding=UTF-8';
export const NATIVE_RELEASE_BUILD_PROVENANCE_SCHEMA_VERSION = 1;
export const NATIVE_RELEASE_BUILD_PROVENANCE_PATH = 'build/native-release-provenance.json';
export const NATIVE_RELEASE_GRADLE_INTEGRITY_MANIFEST_PATH =
  'mobile/gradle/native-release/integrity.json';
export const NATIVE_RELEASE_KEYSTORE_FILENAME = 'calibrate-android-upload.keystore';
export {
  NATIVE_RELEASE_GRADLE_DISTRIBUTION_URL_PROPERTY,
  NATIVE_RELEASE_GRADLE_DISTRIBUTION_SHA256,
  NATIVE_RELEASE_GRADLE_DISTRIBUTION_URL,
  NATIVE_RELEASE_GRADLE_VERSION,
  NATIVE_RELEASE_GRADLE_WRAPPER_JAR_SHA256
};

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROVENANCE_FIELDS = Object.freeze(['schemaVersion', 'sourceCommit', 'releaseManifest', 'artifacts']);
const PROVENANCE_MANIFEST_FIELDS = Object.freeze(['path', 'sha256']);
const PROVENANCE_ARTIFACT_FIELDS = Object.freeze([
  'id', 'role', 'format', 'path', 'sizeBytes', 'sha256', 'applicationId', 'versionName', 'versionCode'
]);

/** Hash exact bytes for reproducible artifact identity. */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Reject missing and additional fields in native build evidence. */
function exactFields(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

/** Read a canonical native release version from its manifest. */
function releaseVersion(manifest, role) {
  const value = manifest?.android?.[role === 'phone' ? 'mobile' : 'wear'];
  return { versionName: value?.version_name, versionCode: value?.version_code };
}

/** Inspect native build inputs from the exact requested source. */
export function readNativeReleaseBuildSource(root = repositoryRoot, execute = execFileSync) {
  /** Provide a deterministic Git adapter for build identity inspection. */
  const git = (args) => execute('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).toString().trim();
  const sourceCommit = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error('Native release build requires HEAD to resolve to a lowercase 40-character Git SHA.');
  }
  if (git(['status', '--porcelain=v1', '--untracked-files=normal'])) {
    throw new Error('Native release build requires a clean worktree and index before artifacts are created.');
  }
  return sourceCommit;
}

/** Record exact native inputs used by the paired artifact build. */
export function createNativeReleaseBuildProvenance(root, sourceCommit) {
  if (!COMMIT_PATTERN.test(sourceCommit ?? '')) {
    throw new Error('Native release build provenance requires a lowercase 40-character sourceCommit.');
  }
  const manifestContent = fs.readFileSync(path.join(root, 'shared', 'release.json'));
  const manifest = JSON.parse(manifestContent.toString('utf8'));
  if (manifest?.android?.application_id !== NATIVE_RELEASE_APPLICATION_ID) {
    throw new Error(`shared/release.json application_id must be ${NATIVE_RELEASE_APPLICATION_ID}.`);
  }
  const artifacts = NATIVE_RELEASE_ARTIFACT_CONTRACTS.map((contract) => {
    const file = path.resolve(root, contract.path);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new Error(`${contract.id} release artifact is missing at ${contract.path}.`);
    }
    if (!stat.isFile()) throw new Error(`${contract.id} release artifact is not a file at ${contract.path}.`);
    const version = releaseVersion(manifest, contract.role);
    if (!version.versionName || !Number.isSafeInteger(version.versionCode) || version.versionCode < 1) {
      throw new Error(`shared/release.json must define a valid ${contract.role} version.`);
    }
    return {
      ...contract,
      sizeBytes: stat.size,
      sha256: sha256(fs.readFileSync(file)),
      applicationId: NATIVE_RELEASE_APPLICATION_ID,
      ...version
    };
  });
  return {
    schemaVersion: NATIVE_RELEASE_BUILD_PROVENANCE_SCHEMA_VERSION,
    sourceCommit,
    releaseManifest: { path: 'shared/release.json', sha256: sha256(manifestContent) },
    artifacts
  };
}

/** Reject source or native-input drift in retained build evidence. */
export function validateNativeReleaseBuildProvenance(provenance, options = {}) {
  const errors = [];
  if (!exactFields(provenance, PROVENANCE_FIELDS)) errors.push('Build provenance fields are invalid.');
  if (provenance?.schemaVersion !== NATIVE_RELEASE_BUILD_PROVENANCE_SCHEMA_VERSION) {
    errors.push(`Build provenance schemaVersion must be ${NATIVE_RELEASE_BUILD_PROVENANCE_SCHEMA_VERSION}.`);
  }
  if (!COMMIT_PATTERN.test(provenance?.sourceCommit ?? '')) errors.push('Build provenance sourceCommit is invalid.');
  if (options.candidateCommit && provenance?.sourceCommit !== options.candidateCommit) {
    errors.push('Build provenance sourceCommit does not match candidate C.');
  }
  if (!exactFields(provenance?.releaseManifest, PROVENANCE_MANIFEST_FIELDS) ||
      provenance?.releaseManifest?.path !== 'shared/release.json' ||
      !SHA256_PATTERN.test(provenance?.releaseManifest?.sha256 ?? '')) {
    errors.push('Build provenance release manifest record is invalid.');
  }
  if (options.manifestContent !== undefined &&
      provenance?.releaseManifest?.sha256 !== sha256(options.manifestContent)) {
    errors.push('Build provenance release manifest hash does not match candidate C.');
  }
  if (!Array.isArray(provenance?.artifacts) || provenance.artifacts.length !== NATIVE_RELEASE_ARTIFACT_CONTRACTS.length) {
    errors.push('Build provenance must contain exactly four artifact records.');
  } else {
    const actualById = new Map((options.artifacts ?? []).map((artifact) => [artifact.id, artifact]));
    const provenanceById = new Map(provenance.artifacts.map((artifact) => [artifact?.id, artifact]));
    if (provenanceById.size !== NATIVE_RELEASE_ARTIFACT_CONTRACTS.length) {
      errors.push('Build provenance artifact IDs must be unique.');
    }
    for (const contract of NATIVE_RELEASE_ARTIFACT_CONTRACTS) {
      const artifact = provenanceById.get(contract.id);
      const actual = actualById.get(contract.id);
      if (!exactFields(artifact, PROVENANCE_ARTIFACT_FIELDS)) {
        errors.push(`Build provenance ${contract.id} fields are invalid.`);
        continue;
      }
      for (const field of ['id', 'role', 'format', 'path']) {
        if (artifact[field] !== contract[field]) errors.push(`Build provenance ${contract.id} ${field} is invalid.`);
      }
      if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1 ||
          !SHA256_PATTERN.test(artifact.sha256 ?? '') ||
          artifact.applicationId !== NATIVE_RELEASE_APPLICATION_ID ||
          !artifact.versionName || !Number.isSafeInteger(artifact.versionCode) || artifact.versionCode < 1) {
        errors.push(`Build provenance ${contract.id} identity is invalid.`);
      }
      if (actual) {
        for (const field of ['role', 'format', 'path', 'sizeBytes', 'sha256', 'applicationId', 'versionName', 'versionCode']) {
          if (artifact[field] !== actual[field]) {
            errors.push(`Build provenance ${contract.id} ${field} does not match the independently inspected artifact.`);
          }
        }
      } else if (options.artifacts) {
        errors.push(`Build provenance ${contract.id} has no independently inspected artifact.`);
      }
    }
  }
  return errors;
}

/** Read and validate retained native build provenance. */
export function readNativeReleaseBuildProvenance(root, options = {}) {
  const relativePath = NATIVE_RELEASE_BUILD_PROVENANCE_PATH;
  const file = path.resolve(root, relativePath);
  let provenance;
  try {
    provenance = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(
      `Native release build provenance is missing or invalid at ${relativePath}. ` +
      'Run npm run native:build -- --credentials-file <external-file> from clean candidate C.'
    );
  }
  const errors = validateNativeReleaseBuildProvenance(provenance, options);
  if (errors.length) throw new Error(`Native release build provenance is invalid:\n- ${errors.join('\n- ')}`);
  return provenance;
}

/** Persist build provenance before credentials are admitted. */
export function writeNativeReleaseBuildProvenance(root, provenance) {
  const errors = validateNativeReleaseBuildProvenance(provenance);
  if (errors.length) throw new Error(`Native release build provenance is invalid:\n- ${errors.join('\n- ')}`);
  const file = path.resolve(root, NATIVE_RELEASE_BUILD_PROVENANCE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
  return NATIVE_RELEASE_BUILD_PROVENANCE_PATH;
}

/** Resolve and validate the shared phone/watch release environment before Gradle can start. */
export function resolveNativeReleaseEnvironment(environment, options = {}) {
  const missing = REQUIRED_SIGNING_ENV.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Native release signing is incomplete. Missing: ${missing.join(', ')}`);
  }

  const storeFile = path.resolve(options.repositoryRoot ?? repositoryRoot, environment.CALIBRATE_ANDROID_SIGNING_STORE_FILE);
  const isFile = options.fileExists ?? ((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!isFile(storeFile)) {
    throw new Error('CALIBRATE_ANDROID_SIGNING_STORE_FILE does not point to a file.');
  }

  const configuredOrigin = environment.EXPO_PUBLIC_CALIBRATE_SERVER_URL?.trim() || 'https://calibratehealth.app';
  let serverUrl;
  try {
    serverUrl = new URL(configuredOrigin);
  } catch {
    throw new Error('EXPO_PUBLIC_CALIBRATE_SERVER_URL must be a credential-free HTTPS origin for release builds.');
  }
  if (serverUrl.protocol !== 'https:' || serverUrl.origin !== configuredOrigin) {
    throw new Error('EXPO_PUBLIC_CALIBRATE_SERVER_URL must be a credential-free HTTPS origin for release builds.');
  }

  let linkedProjectId = options.expoProjectId ?? null;
  try {
    const appConfig = JSON.parse(fs.readFileSync(path.join(
      options.repositoryRoot ?? repositoryRoot,
      'mobile',
      'app.json'
    ), 'utf8'));
    linkedProjectId ??= appConfig.expo?.extra?.eas?.projectId;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const updates = resolveExpoUpdateBuildConfig(environment, linkedProjectId);

  return {
    ...environment,
    CALIBRATE_ANDROID_SIGNING_STORE_FILE: storeFile,
    EXPO_PUBLIC_CALIBRATE_SERVER_URL: serverUrl.origin,
    EXPO_PUBLIC_EAS_PROJECT_ID: updates.projectId ?? '',
    EXPO_UPDATES_CHANNEL: updates.channel,
    // Generated CNG directories are not independent native inputs; use the same policy as OTA exports.
    EXPO_UPDATES_WORKFLOW_OVERRIDE: 'managed',
    EXPO_UPDATES_FINGERPRINT_OVERRIDE: '',
    // Keep Metro rooted at the mobile app when the release build is launched from this workspace.
    EXPO_NO_METRO_WORKSPACE_ROOT: '1',
    NODE_ENV: 'production'
  };
}

/** Construct paired release tasks without rebuilding during submission. */
export function nativeReleaseGradleCommands(platform = process.platform) {
  const wrapper = platform === 'win32' ? 'gradlew.bat' : './gradlew';
  const common = [
    `-Dorg.gradle.jvmargs=${RELEASE_GRADLE_JVM_ARGS}`,
    '--dependency-verification=strict',
    '--no-daemon',
    '--console=plain'
  ];
  return [
    {
      label: 'phone',
      cwd: path.join(repositoryRoot, 'mobile', 'android'),
      command: wrapper,
      args: [':app:bundleRelease', ':app:assembleRelease', ...common]
    },
    {
      label: 'wear',
      cwd: path.join(repositoryRoot, 'wear'),
      command: wrapper,
      args: [':app:bundleRelease', ':app:assembleRelease', ...common]
    }
  ];
}

/** Parse reviewed Gradle properties without evaluating arbitrary project code. */
function gradlePropertyValues(source, name) {
  const pattern = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`);
  return source.split(/\r?\n/).flatMap((line) => {
    const match = line.match(pattern);
    return match ? [match[1]] : [];
  });
}

/** Reject generated or checked-in wrapper code that differs from the reviewed Gradle release. */
export function assertNativeReleaseGradleWrapper(build, options = {}) {
  const readFile = options.readFile ?? fs.readFileSync;
  const propertiesFile = path.join(build.cwd, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  const wrapperJar = path.join(build.cwd, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  let properties;
  let wrapperJarBytes;
  try {
    properties = readFile(propertiesFile, 'utf8').toString();
  } catch {
    throw new Error(`${build.label} Gradle wrapper properties are missing.`);
  }
  try {
    wrapperJarBytes = readFile(wrapperJar);
  } catch {
    throw new Error(`${build.label} Gradle wrapper JAR is missing.`);
  }

  const distributionUrls = gradlePropertyValues(properties, 'distributionUrl');
  if (distributionUrls.length !== 1 ||
      distributionUrls[0] !== NATIVE_RELEASE_GRADLE_DISTRIBUTION_URL_PROPERTY) {
    throw new Error(
      `${build.label} Gradle wrapper must pin distributionUrl=` +
      `${NATIVE_RELEASE_GRADLE_DISTRIBUTION_URL_PROPERTY}.`
    );
  }
  const distributionChecksums = gradlePropertyValues(properties, 'distributionSha256Sum');
  if (distributionChecksums.length !== 1 ||
      distributionChecksums[0] !== NATIVE_RELEASE_GRADLE_DISTRIBUTION_SHA256) {
    throw new Error(
      `${build.label} Gradle wrapper must pin distributionSha256Sum=` +
      `${NATIVE_RELEASE_GRADLE_DISTRIBUTION_SHA256}.`
    );
  }

  const wrapperJarSha256 = sha256(wrapperJarBytes);
  if (wrapperJarSha256 !== NATIVE_RELEASE_GRADLE_WRAPPER_JAR_SHA256) {
    throw new Error(
      `${build.label} Gradle wrapper JAR SHA-256 ${wrapperJarSha256} does not match the reviewed ` +
      `Gradle ${NATIVE_RELEASE_GRADLE_VERSION} wrapper JAR.`
    );
  }
}

/** Bind native dependency verification files to the prepared build. */
function nativeReleaseGradleIntegrityManifest(options = {}) {
  if (options.manifest) return options.manifest;
  const readFile = options.readFile ?? fs.readFileSync;
  const root = options.repositoryRoot ?? repositoryRoot;
  try {
    return JSON.parse(readFile(
      path.join(root, NATIVE_RELEASE_GRADLE_INTEGRITY_MANIFEST_PATH),
      'utf8'
    ).toString());
  } catch {
    throw new Error(
      `Native release Gradle integrity manifest is missing or invalid at ` +
      `${NATIVE_RELEASE_GRADLE_INTEGRITY_MANIFEST_PATH}.`
    );
  }
}

/** Limit restored Gradle state to approved build-tool locations. */
function validGradleStatePath(relativePath) {
  return typeof relativePath === 'string' &&
    relativePath.length > 0 &&
    !relativePath.includes('\\') &&
    !path.posix.isAbsolute(relativePath) &&
    path.posix.normalize(relativePath) === relativePath &&
    relativePath !== '..' &&
    !relativePath.startsWith('../');
}

/** Normalize retained Gradle state for reproducible comparisons. */
function canonicalNativeReleaseGradleStateText(bytes) {
  const source = bytes.toString('utf8');
  if (source.includes('\uFFFD') || /\r(?!\n)/.test(source)) {
    throw new Error('reviewed Gradle dependency state must be UTF-8 text with LF or CRLF lines');
  }
  return source.replace(/\r\n/g, '\n');
}

/** Require reviewed Gradle dependency verification metadata. */
export function assertNativeReleaseVerificationMetadata(label, source) {
  if (source.includes('<!--') || source.includes('-->')) {
    throw new Error(`${label} Gradle verification metadata must not contain XML comments.`);
  }
  if ((source.match(/<verify-metadata>true<\/verify-metadata>/g) ?? []).length !== 1 ||
      /<(?:trusted-artifacts|trusted-keys|ignored-artifacts|ignored-keys|key-servers?|key-server)\b/.test(source)) {
    throw new Error(
      `${label} Gradle verification metadata must verify metadata without trust or ignore shortcuts.`
    );
  }
  const componentOpenCount = (source.match(/<component\b/g) ?? []).length;
  const components = [...source.matchAll(
    /<component\b[^>]*\bgroup="([^"]+)"[^>]*\bname="([^"]+)"[^>]*\bversion="([^"]+)"[^>]*>([\s\S]*?)<\/component>/g
  )];
  if (componentOpenCount === 0 || components.length !== componentOpenCount) {
    throw new Error(`${label} Gradle verification metadata has malformed component records.`);
  }
  const artifactOpenCount = (source.match(/<artifact\b/g) ?? []).length;
  const artifactCoordinates = new Set();
  let parsedArtifactCount = 0;
  for (const [, group, name, version, componentBody] of components) {
    const componentArtifactOpenCount = (componentBody.match(/<artifact\b/g) ?? []).length;
    const artifacts = [...componentBody.matchAll(
      /<artifact\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/artifact>/g
    )];
    if (artifacts.length !== componentArtifactOpenCount) {
      throw new Error(`${label} Gradle verification metadata has malformed artifact records.`);
    }
    for (const [, artifactName, body] of artifacts) {
      parsedArtifactCount += 1;
      const coordinate = `${group}:${name}:${version}:${artifactName}`;
      if (artifactCoordinates.has(coordinate)) {
        throw new Error(`${label} Gradle verification metadata has duplicate artifact records.`);
      }
      artifactCoordinates.add(coordinate);
      const shaTags = [...body.matchAll(/<sha256\b[^>]*\bvalue="([^"]+)"[^>]*\/?\s*>/g)];
      if (shaTags.length !== 1 || !SHA256_PATTERN.test(shaTags[0][1])) {
        throw new Error(
          `${label} Gradle verification metadata must give every artifact exactly one 64-hex SHA-256.`
        );
      }
    }
  }
  if (artifactOpenCount === 0 || parsedArtifactCount !== artifactOpenCount) {
    throw new Error(`${label} Gradle verification metadata has malformed artifact records.`);
  }

  const commonArtifacts = [
    /<artifact name="kotlin-gradle-plugin-[^"]+\.jar">/,
    /<artifact name="[^"]+\.pom">/,
    /<artifact name="[^"]+\.module">/,
    /<artifact name="play-services-wearable-[^"]+\.aar">/
  ];
  const platformArtifacts = label === 'phone'
    ? [
        /<component group="org\.jetbrains\.kotlin\.jvm" name="org\.jetbrains\.kotlin\.jvm\.gradle\.plugin"/,
        /<artifact name="react-android-[^"]+-release\.aar">/
      ]
    : [
        /<component group="com\.android\.application" name="com\.android\.application\.gradle\.plugin"/,
        /<artifact name="room-runtime\.aar">/,
        /<artifact name="compose-bom-[^"]+\.pom">/
      ];
  const commonCleanRunArtifacts = [
    'com.google.guava:guava-parent:33.3.1-jre:guava-parent-33.3.1-jre.pom',
    'org.junit:junit-bom:5.10.2:junit-bom-5.10.2.module',
    'org.jetbrains.kotlinx:kotlinx-coroutines-bom:1.8.0:kotlinx-coroutines-bom-1.8.0.pom'
  ];
  const phoneCleanRunArtifacts = [
    'com.android.tools.build:aapt2:8.12.0-13700139:aapt2-8.12.0-13700139-linux.jar',
    'com.android.tools.build:aapt2:8.12.0-13700139:aapt2-8.12.0-13700139-windows.jar',
    'com.android.tools.build:aapt2:8.12.0-13700139:aapt2-8.12.0-13700139.pom',
    'com.android.tools:play-sdk-proto:31.12.0:play-sdk-proto-31.12.0.jar',
    'com.android.tools:play-sdk-proto:31.12.0:play-sdk-proto-31.12.0.pom',
    'com.android.tools.external.com-intellij:intellij-core:31.12.0:intellij-core-31.12.0.jar',
    'com.android.tools.external.com-intellij:intellij-core:31.12.0:intellij-core-31.12.0.pom',
    'com.android.tools.external.com-intellij:kotlin-compiler:31.12.0:kotlin-compiler-31.12.0.jar',
    'com.android.tools.external.com-intellij:kotlin-compiler:31.12.0:kotlin-compiler-31.12.0.pom',
    'com.android.tools.external.org-jetbrains:uast:31.12.0:uast-31.12.0.jar',
    'com.android.tools.external.org-jetbrains:uast:31.12.0:uast-31.12.0.pom',
    'com.android.tools.lint:lint:31.12.0:lint-31.12.0.jar',
    'com.android.tools.lint:lint:31.12.0:lint-31.12.0.pom',
    'com.android.tools.lint:lint-api:31.12.0:lint-api-31.12.0.jar',
    'com.android.tools.lint:lint-api:31.12.0:lint-api-31.12.0.pom',
    'com.android.tools.lint:lint-checks:31.12.0:lint-checks-31.12.0.jar',
    'com.android.tools.lint:lint-checks:31.12.0:lint-checks-31.12.0.pom',
    'com.android.tools.lint:lint-gradle:31.12.0:lint-gradle-31.12.0.jar',
    'com.android.tools.lint:lint-gradle:31.12.0:lint-gradle-31.12.0.pom',
    'com.google.devtools.ksp:symbol-processing-aa-embeddable:2.1.20-2.0.1:symbol-processing-aa-embeddable-2.1.20-2.0.1.jar',
    'com.google.devtools.ksp:symbol-processing-aa-embeddable:2.1.20-2.0.1:symbol-processing-aa-embeddable-2.1.20-2.0.1.pom',
    'com.google.guava:guava-parent:32.1.3-jre:guava-parent-32.1.3-jre.pom',
    'com.google.guava:guava-parent:33.3.1-android:guava-parent-33.3.1-android.pom',
    'com.google.guava:guava-parent:33.4.3-android:guava-parent-33.4.3-android.pom',
    'com.google.guava:guava-parent:33.4.8-jre:guava-parent-33.4.8-jre.pom',
    'org.apache.httpcomponents:httpclient:4.5.6:httpclient-4.5.6.jar',
    'org.apache.httpcomponents:httpclient:4.5.6:httpclient-4.5.6.pom',
    'org.codehaus.groovy:groovy:3.0.22:groovy-3.0.22.jar',
    'org.codehaus.groovy:groovy:3.0.22:groovy-3.0.22.pom',
    'org.jetbrains.kotlin:kotlin-bom:1.8.0:kotlin-bom-1.8.0.pom',
    'org.junit:junit-bom:5.13.1:junit-bom-5.13.1.module',
    'org.junit:junit-bom:5.13.4:junit-bom-5.13.4.module',
    'org.junit:junit-bom:5.8.2:junit-bom-5.8.2.pom',
    'org.junit:junit-bom:5.9.2:junit-bom-5.9.2.module',
    'org.junit:junit-bom:5.9.3:junit-bom-5.9.3.module'
  ];
  const wearCleanRunArtifacts = [
    'com.android.tools.build:aapt2:8.11.0-12782657:aapt2-8.11.0-12782657-linux.jar',
    'com.android.tools.build:aapt2:8.11.0-12782657:aapt2-8.11.0-12782657-windows.jar',
    'com.android.tools.build:aapt2:8.11.0-12782657:aapt2-8.11.0-12782657.pom',
    'com.android.tools.lint:lint:31.11.0:lint-31.11.0.jar',
    'com.android.tools.lint:lint:31.11.0:lint-31.11.0.pom',
    'com.android.tools.lint:lint-gradle:31.11.0:lint-gradle-31.11.0.jar',
    'com.android.tools.lint:lint-gradle:31.11.0:lint-gradle-31.11.0.pom'
  ];
  const cleanRunArtifacts = [
    ...commonCleanRunArtifacts,
    ...(label === 'phone' ? phoneCleanRunArtifacts : wearCleanRunArtifacts)
  ];
  if (
    ![...commonArtifacts, ...platformArtifacts].every((pattern) => pattern.test(source)) ||
    !cleanRunArtifacts.every((artifactCoordinate) => artifactCoordinates.has(artifactCoordinate))
  ) {
    throw new Error(
      `${label} Gradle verification metadata omits representative plugin or clean-run release artifacts.`
    );
  }
}

/**
 * Bind the checked-in checksum and lock state to the exact files each release
 * wrapper will consume. The phone state is restored by Expo prebuild first.
 */
export function assertNativeReleaseGradleDependencyState(build, options = {}) {
  const manifest = nativeReleaseGradleIntegrityManifest(options);
  const state = manifest?.schemaVersion === 1 ? manifest.platforms?.[build.label] : null;
  if (!state || !Array.isArray(state.files) || state.files.length === 0) {
    throw new Error(`${build.label} reviewed Gradle dependency state is missing from the integrity manifest.`);
  }

  const requiredPaths = build.label === 'phone'
    ? [
        'buildscript-gradle.lockfile',
        'settings-gradle.lockfile',
        'gradle/verification-metadata.xml'
      ]
    : [
        'app/gradle.lockfile',
        'settings-gradle.lockfile',
        'gradle/verification-metadata.xml'
      ];
  const seen = new Set();
  let verificationMetadata = null;
  let dependencyLockCount = 0;
  const readFile = options.readFile ?? fs.readFileSync;

  for (const record of state.files) {
    if (!validGradleStatePath(record?.path) ||
        !SHA256_PATTERN.test(record?.sha256 ?? '') ||
        seen.has(record.path)) {
      throw new Error(`${build.label} Gradle dependency integrity manifest entries are invalid.`);
    }
    seen.add(record.path);
    const file = path.join(build.cwd, ...record.path.split('/'));
    let bytes;
    try {
      bytes = readFile(file);
    } catch {
      throw new Error(`${build.label} reviewed Gradle dependency state is missing: ${record.path}.`);
    }
    let source;
    try {
      source = canonicalNativeReleaseGradleStateText(bytes);
    } catch (error) {
      throw new Error(`${build.label} ${error.message}: ${record.path}.`, { cause: error });
    }
    const actualSha256 = sha256(Buffer.from(source, 'utf8'));
    if (actualSha256 !== record.sha256) {
      throw new Error(
        `${build.label} reviewed Gradle dependency state changed: ${record.path} ` +
        `has SHA-256 ${actualSha256}.`
      );
    }

    if (record.path === 'gradle/verification-metadata.xml') {
      verificationMetadata = source;
    } else if (record.path.endsWith('.lockfile')) {
      dependencyLockCount += 1;
      if (!source.includes('This is a Gradle generated file for dependency locking.') ||
          !/^[^#\s][^=\r\n]*=[^\r\n]+/m.test(source)) {
        throw new Error(`${build.label} Gradle lock state is incomplete: ${record.path}.`);
      }
    }
  }

  for (const requiredPath of requiredPaths) {
    if (!seen.has(requiredPath)) {
      throw new Error(`${build.label} integrity manifest omits required state: ${requiredPath}.`);
    }
  }
  if (build.label === 'phone' &&
      ![...seen].some((entry) => entry.startsWith('gradle/dependency-locks/'))) {
    throw new Error('phone integrity manifest omits generated project dependency locks.');
  }
  if (dependencyLockCount < 2 ||
      !verificationMetadata?.includes('<components>')) {
    throw new Error(`${build.label} Gradle verification metadata or dependency locks are incomplete.`);
  }
  assertNativeReleaseVerificationMetadata(build.label, verificationMetadata);

  const buildScriptName = build.label === 'phone' ? 'build.gradle' : 'build.gradle.kts';
  let buildScript;
  try {
    buildScript = readFile(path.join(build.cwd, buildScriptName), 'utf8').toString();
  } catch {
    throw new Error(`${build.label} Gradle build script is missing.`);
  }
  if (!buildScript.includes('lockAllConfigurations()') ||
      !buildScript.includes('LockMode.STRICT') ||
      (build.label === 'phone' &&
        !buildScript.includes('gradle/dependency-locks/'))) {
    throw new Error(`${build.label} Gradle dependency locking must use complete state in LockMode.STRICT.`);
  }
}

/** Identify the exact pinned Gradle distribution cache. */
export function nativeReleaseGradleDistributionCachePath(environment = process.env, options = {}) {
  const configuredGradleHome = environment.GRADLE_USER_HOME?.trim();
  const gradleUserHome = configuredGradleHome
    ? path.resolve(configuredGradleHome)
    : path.resolve(options.homeDirectory ?? os.homedir(), '.gradle');
  const wrapperDists = path.resolve(gradleUserHome, 'wrapper', 'dists');
  const distributionCache = path.resolve(
    wrapperDists,
    `gradle-${NATIVE_RELEASE_GRADLE_VERSION}-bin`
  );
  if (path.dirname(distributionCache) !== wrapperDists) {
    throw new Error('Native release Gradle distribution cache path escaped wrapper/dists.');
  }
  return distributionCache;
}

/**
 * Force the pinned distribution checksum to run without discarding dependency caches.
 * setup-java may restore the wrapper distribution alongside ~/.gradle/caches.
 */
export function removeNativeReleaseGradleDistributionCache(environment = process.env, options = {}) {
  const distributionCache = nativeReleaseGradleDistributionCachePath(environment, options);
  const removeDirectory = options.removeDirectory ??
    ((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  removeDirectory(distributionCache);
  return distributionCache;
}

/** Validate every wrapper before evicting the exact distribution that the first wrapper will load. */
export function prepareNativeReleaseGradleExecution(builds, environment = process.env, options = {}) {
  assertNativeReleaseGradleInputs(builds, options);
  const removeDistributionCache = options.removeDistributionCache ??
    removeNativeReleaseGradleDistributionCache;
  return removeDistributionCache(environment, options);
}

/** Fail before signing when prepared Gradle inputs have changed. */
export function assertNativeReleaseGradleInputs(builds, options = {}) {
  const assertWrapper = options.assertWrapper ?? assertNativeReleaseGradleWrapper;
  const assertDependencyState = options.assertDependencyState ??
    assertNativeReleaseGradleDependencyState;
  for (const build of builds) assertWrapper(build);
  for (const build of builds) assertDependencyState(build);
}

/** Return the four expected phone and Wear artifact locations. */
export function nativeReleaseArtifactPaths(build) {
  const outputRoot = path.join(build.cwd, 'app', 'build', 'outputs');
  return [
    path.join(outputRoot, 'apk', 'release', 'app-release.apk'),
    path.join(outputRoot, 'bundle', 'release', 'app-release.aab')
  ];
}

/** Ensure a successful Gradle exit cannot reuse or conceal missing release outputs. */
export function prepareNativeReleaseArtifacts(build, removeFile = (file) => fs.rmSync(file, { force: true })) {
  for (const file of nativeReleaseArtifactPaths(build)) removeFile(file);
}

/** Require the exact paired release outputs before publication. */
export function assertNativeReleaseArtifacts(build, fileExists = fs.existsSync) {
  const missing = nativeReleaseArtifactPaths(build).filter((file) => !fileExists(file));
  if (missing.length === 0) return;
  throw new Error(
    `${build.label} Gradle completed without producing the expected release artifacts:\n` +
    `${missing.map((file) => `  - ${file}`).join('\n')}\n` +
    `Review the earlier ${build.label} Gradle output for a masked daemon, lint, or memory failure.`
  );
}

/** Construct credential-free managed Android prebuild. */
export function nativeReleasePrebuildCommand(root = repositoryRoot) {
  return {
    label: 'phone prebuild',
    cwd: path.join(root, 'mobile'),
    command: process.execPath,
    args: [
      path.join(root, 'node_modules', 'expo', 'bin', 'cli'),
      'prebuild',
      '--platform',
      'android',
      '--clean',
      '--no-install'
    ]
  };
}

/** Fail closed rather than trying to hide signing material after it has been admitted. */
export function nativeReleaseCredentialFreeEnvironment(environment = process.env, options = {}) {
  const admitted = Object.keys(environment).filter((name) => name.startsWith('CALIBRATE_ANDROID_'));
  if (admitted.length > 0) {
    throw new Error(
      `Credential-free native preparation rejects admitted Android signing variables: ` +
      `${admitted.sort().join(', ')}.`
    );
  }
  const runnerTemp = path.resolve(environment.RUNNER_TEMP?.trim() || os.tmpdir());
  const fixedKeystore = path.join(runnerTemp, NATIVE_RELEASE_KEYSTORE_FILENAME);
  const fileExists = options.fileExists ?? fs.existsSync;
  if (fileExists(fixedKeystore)) {
    throw new Error(
      `Credential-free native preparation rejects existing signing material at ` +
      `${NATIVE_RELEASE_KEYSTORE_FILENAME}.`
    );
  }
  return { ...environment };
}

/** Run Gradle's wrapper jar directly on Windows so release arguments never pass through cmd.exe. */
export function nativeReleaseInvocation(build, args, environment, platform = process.platform) {
  if (platform !== 'win32') return { command: build.command, args };
  const javaExecutable = environment.JAVA_HOME?.trim()
    ? path.join(environment.JAVA_HOME, 'bin', 'java.exe')
    : 'java.exe';
  return {
    command: javaExecutable,
    args: [
      '-classpath',
      path.join(build.cwd, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
      'org.gradle.wrapper.GradleWrapperMain',
      ...args
    ]
  };
}

/** Prepare verified Gradle inputs before admitting signing credentials. */
function prepareGradle() {
  const prebuild = nativeReleasePrebuildCommand();
  const prebuildResult = spawnSync(prebuild.command, prebuild.args, {
    cwd: prebuild.cwd,
    env: nativeReleaseCredentialFreeEnvironment(process.env),
    stdio: 'inherit'
  });
  if (prebuildResult.error) throw prebuildResult.error;
  if (prebuildResult.status !== 0) process.exit(prebuildResult.status ?? 1);

  const builds = nativeReleaseGradleCommands();
  for (const build of builds) {
    if (!fs.existsSync(path.join(build.cwd, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'))) {
      throw new Error(`${build.label} Gradle wrapper is missing. Run a clean Android prebuild before release.`);
    }
  }
  const environment = nativeReleaseCredentialFreeEnvironment(process.env);
  const removedDistributionCache = prepareNativeReleaseGradleExecution(builds, environment);
  console.log(
    'Credential-free phone prebuild and phone/Wear Gradle integrity verification completed. ' +
    `Removed the pinned Gradle distribution cache at ${removedDistributionCache}.`
  );
}

/** Execute the requested build-tool operation through the injected runner. */
function run() {
  const provenanceFile = path.resolve(repositoryRoot, NATIVE_RELEASE_BUILD_PROVENANCE_PATH);
  fs.rmSync(provenanceFile, { force: true });
  const sourceCommit = readNativeReleaseBuildSource(repositoryRoot);
  const builds = nativeReleaseGradleCommands();
  for (const build of builds) {
    if (!fs.existsSync(path.join(build.cwd, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'))) {
      throw new Error(
        `${build.label} Gradle wrapper is missing. Run ` +
        '`node scripts/native-release-build.mjs prepare` before admitting signing credentials.'
      );
    }
  }
  assertNativeReleaseGradleInputs(builds);
  const environment = resolveNativeReleaseEnvironment(process.env);
  const removedDistributionCache = removeNativeReleaseGradleDistributionCache(environment);
  console.log(`Removed the pinned Gradle distribution cache at ${removedDistributionCache}.`);

  for (const build of builds) {
    prepareNativeReleaseArtifacts(build);
    const args = build.label === 'wear'
      ? [`-PcalibrateWearServerUrl=${environment.EXPO_PUBLIC_CALIBRATE_SERVER_URL}`, ...build.args]
      : build.args;
    const invocation = nativeReleaseInvocation(build, args, environment);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: build.cwd,
      env: environment,
      stdio: 'inherit'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    assertNativeReleaseArtifacts(build);
  }

  const otaBaseline = writeNativeOtaBaseline({ root: repositoryRoot, environment, commit: sourceCommit });
  if (otaBaseline) {
    console.log(`Recorded OTA compatibility baseline at ${otaBaseline.output}`);
  } else {
    console.log('Expo OTA is disabled for this build because EXPO_PUBLIC_EAS_PROJECT_ID was not set.');
  }
  const provenance = createNativeReleaseBuildProvenance(repositoryRoot, sourceCommit);
  const output = writeNativeReleaseBuildProvenance(repositoryRoot, provenance);
  console.log(`Recorded candidate-bound native release provenance at ${output}.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const command = process.argv[2];
  if (command === 'prepare') {
    prepareGradle();
  } else if (command === 'build-prepared') {
    run();
  } else {
    throw new Error(
      'Native release build requires an explicit prepare or build-prepared command.'
    );
  }
}
