/** @file Regression coverage for native signing, reviewed Gradle dependency state, and release artifact contracts. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  injectNativeDependencyLocking,
  injectWindowsNativeObjectPathLimit,
  nativeReleaseGradleContract,
  pinNativeReleaseGradleWrapperProperties,
  restorePhoneGradleDependencyState
} from '../mobile/plugins/nativeReleaseGradleWrapper.js';
import {
  assertNativeReleaseArtifacts,
  assertNativeReleaseGradleDependencyState,
  assertNativeReleaseGradleWrapper,
  assertNativeReleaseVerificationMetadata,
  createNativeReleaseBuildProvenance,
  NATIVE_RELEASE_GRADLE_DISTRIBUTION_SHA256,
  NATIVE_RELEASE_GRADLE_DISTRIBUTION_URL_PROPERTY,
  NATIVE_RELEASE_GRADLE_WRAPPER_JAR_SHA256,
  NATIVE_RELEASE_BUILD_PROVENANCE_PATH,
  nativeReleaseArtifactPaths,
  nativeReleaseGradleDistributionCachePath,
  nativeReleaseGradleCommands,
  nativeReleaseCredentialFreeEnvironment,
  nativeReleaseInvocation,
  nativeReleasePrebuildCommand,
  prepareNativeReleaseArtifacts,
  prepareNativeReleaseGradleExecution,
  readNativeReleaseBuildProvenance,
  readNativeReleaseBuildSource,
  RELEASE_GRADLE_JVM_ARGS,
  removeNativeReleaseGradleDistributionCache,
  resolveNativeReleaseEnvironment,
  writeNativeReleaseBuildProvenance
} from './native-release-build.mjs';
import { NATIVE_RELEASE_ARTIFACT_CONTRACTS } from './native-release-evidence.mjs';

const officialGradleWrapperJar = fs.readFileSync(
  new URL('../mobile/gradle/wrapper/gradle-wrapper.jar', import.meta.url)
);
const wearGradleWrapperJar = fs.readFileSync(
  new URL('../wear/gradle/wrapper/gradle-wrapper.jar', import.meta.url)
);

const signingEnvironment = {
  CALIBRATE_ANDROID_SIGNING_STORE_FILE: 'signing/calibrate.p12',
  CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD: 'store-password',
  CALIBRATE_ANDROID_SIGNING_KEY_ALIAS: 'calibrate',
  CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD: 'key-password'
};

test('native release environment enforces one complete signing identity and a production origin', () => {
  const resolved = resolveNativeReleaseEnvironment({
    ...signingEnvironment,
    EXPO_PUBLIC_CALIBRATE_SERVER_URL: 'https://health.example'
  }, {
    repositoryRoot: 'C:/repo',
    fileExists: () => true
  });

  assert.equal(resolved.EXPO_PUBLIC_CALIBRATE_SERVER_URL, 'https://health.example');
  assert.equal(resolved.EXPO_NO_METRO_WORKSPACE_ROOT, '1');
  assert.equal(resolved.NODE_ENV, 'production');
  assert.equal(resolved.EXPO_UPDATES_CHANNEL, 'beta');
  assert.match(resolved.CALIBRATE_ANDROID_SIGNING_STORE_FILE, /signing[\\/]calibrate\.p12$/);
});

test('native release environment defaults to the official hosted service', () => {
  const resolved = resolveNativeReleaseEnvironment(signingEnvironment, {
    repositoryRoot: 'C:/repo',
    fileExists: () => true
  });

  assert.equal(resolved.EXPO_PUBLIC_CALIBRATE_SERVER_URL, 'https://calibratehealth.app');
});

test('native release environment rejects incomplete signing and non-origin HTTP URLs', () => {
  assert.throws(
    () => resolveNativeReleaseEnvironment({}, { fileExists: () => true }),
    /signing is incomplete/
  );
  assert.throws(
    () => resolveNativeReleaseEnvironment({
      ...signingEnvironment,
      EXPO_PUBLIC_CALIBRATE_SERVER_URL: 'http://health.example/path'
    }, { fileExists: () => true }),
    /HTTPS origin/
  );
  assert.throws(
    () => resolveNativeReleaseEnvironment({
      ...signingEnvironment,
      EXPO_PUBLIC_CALIBRATE_SERVER_URL: 'not a URL'
    }, { fileExists: () => true }),
    /HTTPS origin/
  );
  assert.throws(
    () => resolveNativeReleaseEnvironment(signingEnvironment, { fileExists: () => false }),
    /does not point to a file/
  );
  assert.throws(
    () => resolveNativeReleaseEnvironment({
      ...signingEnvironment,
      EXPO_PUBLIC_EAS_PROJECT_ID: 'not-a-uuid'
    }, { fileExists: () => true }),
    /project UUID/
  );
});

test('native release build always produces phone and Wear APK plus AAB tasks', () => {
  for (const platform of ['win32', 'linux']) {
    const commands = nativeReleaseGradleCommands(platform);
    assert.deepEqual(commands.map(({ label }) => label), ['phone', 'wear']);
    for (const command of commands) {
      assert.ok(command.args.includes(':app:bundleRelease'));
      assert.ok(command.args.includes(':app:assembleRelease'));
      assert.ok(command.args.includes('--dependency-verification=strict'));
      assert.ok(command.args.includes('--no-daemon'));
      assert.ok(command.args.includes(`-Dorg.gradle.jvmargs=${RELEASE_GRADLE_JVM_ARGS}`));
    }
  }
});

test('Expo prebuild finalization restores the reviewed phone Gradle wrapper pins', () => {
  const generated = [
    'distributionBase=GRADLE_USER_HOME',
    'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.0.0-bin.zip',
    `distributionSha256Sum=${'0'.repeat(64)}`,
    'networkTimeout=10000',
    ''
  ].join('\n');
  const pinned = pinNativeReleaseGradleWrapperProperties(generated);
  const pinnedLines = pinned.split(/\r?\n/);

  assert.ok(pinnedLines.includes(
    `distributionUrl=${NATIVE_RELEASE_GRADLE_DISTRIBUTION_URL_PROPERTY}`
  ));
  assert.ok(pinnedLines.includes(
    `distributionSha256Sum=${NATIVE_RELEASE_GRADLE_DISTRIBUTION_SHA256}`
  ));
  assert.equal((pinned.match(/^distributionSha256Sum=/gm) ?? []).length, 1);
  assert.equal(pinNativeReleaseGradleWrapperProperties(pinned), pinned);

  const appConfig = JSON.parse(fs.readFileSync(new URL('../mobile/app.json', import.meta.url), 'utf8'));
  assert.ok(appConfig.expo.plugins.includes('./plugins/withPinnedGradleWrapper'));

  const lockedBuild = injectNativeDependencyLocking('apply plugin: "com.facebook.react.rootproject"');
  assert.match(lockedBuild, /lockAllConfigurations\(\)/);
  assert.match(lockedBuild, /LockMode\.STRICT/);
  assert.match(lockedBuild, /gradle\/dependency-locks\/\$\{calibrateDependencyLockName\}\.lockfile/);
  assert.equal(injectNativeDependencyLocking(lockedBuild), lockedBuild);
  const boundedBuild = injectWindowsNativeObjectPathLimit(lockedBuild);
  assert.match(boundedBuild, /System\.getProperty\('os.name'\).startsWith\('Windows'\)/);
  assert.match(boundedBuild, /-DCMAKE_OBJECT_PATH_MAX=240/);
  assert.ok(boundedBuild.includes('../../.cache/cxx/${calibrateCmakeProject}'));
  assert.match(boundedBuild, /externalNativeBuild\.cmake\.buildStagingDirectory/);
  assert.ok(boundedBuild.indexOf('buildStagingDirectory') < boundedBuild.indexOf('apply plugin:'));
  assert.equal(injectWindowsNativeObjectPathLimit(boundedBuild), boundedBuild);
});

test('credential-free prebuild rejects admitted Android signing values and fixed keystore', () => {
  const clean = {
    RUNNER_TEMP: 'C:/runner-temp',
    EXPO_PUBLIC_CALIBRATE_SERVER_URL: 'https://calibratehealth.app'
  };
  assert.deepEqual(
    nativeReleaseCredentialFreeEnvironment(clean, { fileExists: () => false }),
    clean
  );
  assert.throws(
    () => nativeReleaseCredentialFreeEnvironment(
      { ...clean, CALIBRATE_ANDROID_SIGNING_KEY_ALIAS: 'secret' },
      { fileExists: () => false }
    ),
    /rejects admitted Android signing variables: CALIBRATE_ANDROID_SIGNING_KEY_ALIAS/
  );
  assert.throws(
    () => nativeReleaseCredentialFreeEnvironment(
      { ...clean, CALIBRATE_ANDROID_UPLOAD_KEYSTORE_BASE64: 'secret-keystore' },
      { fileExists: () => false }
    ),
    /rejects admitted Android signing variables: CALIBRATE_ANDROID_UPLOAD_KEYSTORE_BASE64/
  );
  let checkedPath;
  assert.throws(
    () => nativeReleaseCredentialFreeEnvironment(clean, {
      fileExists: (candidate) => {
        checkedPath = candidate;
        return true;
      }
    }),
    /rejects existing signing material at calibrate-android-upload\.keystore/
  );
  assert.match(checkedPath, /runner-temp[\\/]calibrate-android-upload\.keystore$/);
});

test('Expo finalization copies every reviewed phone dependency-state file', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-phone-gradle-restore-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const projectRoot = path.join(fixture, 'mobile');
  const templateRoot = path.join(projectRoot, 'gradle', 'native-release', 'phone');
  const platformRoot = path.join(projectRoot, 'android');
  const expected = new Map([
    ['buildscript-gradle.lockfile', gradleLockFixture],
    ['settings-gradle.lockfile', gradleLockFixture],
    ['gradle/verification-metadata.xml', verificationMetadataFixture],
    ['gradle/dependency-locks/app.lockfile', gradleLockFixture]
  ]);
  for (const [relativePath, content] of expected) {
    const file = path.join(templateRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.mkdirSync(path.join(platformRoot, 'gradle'), { recursive: true });

  restorePhoneGradleDependencyState(projectRoot, platformRoot);
  for (const [relativePath, content] of expected) {
    assert.equal(
      fs.readFileSync(path.join(platformRoot, ...relativePath.split('/')), 'utf8'),
      content
    );
  }
  assert.throws(
    () => restorePhoneGradleDependencyState(path.join(fixture, 'missing'), platformRoot),
    /Reviewed phone Gradle dependency state is missing/
  );
});

function canonicalGradleWrapperProperties(overrides = {}) {
  const contract = nativeReleaseGradleContract(overrides.label);
  return [
    `distributionUrl=${overrides.distributionUrl ?? contract.distributionUrlProperty}`,
    ...(!overrides.omitChecksum
      ? [`distributionSha256Sum=${overrides.distributionSha256Sum ??
        contract.distributionSha256}`]
      : []),
    ''
  ].join('\n');
}

function writeGradleWrapperFixture(root, options = {}) {
  const wrapperDirectory = path.join(root, 'gradle', 'wrapper');
  fs.mkdirSync(wrapperDirectory, { recursive: true });
  if (!options.omitProperties) {
    fs.writeFileSync(
      path.join(wrapperDirectory, 'gradle-wrapper.properties'),
      options.properties ?? canonicalGradleWrapperProperties(options)
    );
  }
  if (!options.omitJar) {
    fs.writeFileSync(
      path.join(wrapperDirectory, 'gradle-wrapper.jar'),
      options.jar ?? (options.label === 'wear' ? wearGradleWrapperJar : officialGradleWrapperJar)
    );
  }
}

const gradleLockFixture = [
  '# This is a Gradle generated file for dependency locking.',
  '# Manual edits can break the build and are not advised.',
  '# This file is expected to be part of source control.',
  'example:dependency:1.0=releaseRuntimeClasspath',
  ''
].join('\n');
const fixtureSha256 = 'a'.repeat(64);
const commonCleanRunArtifactCoordinates = [
  'com.google.guava:guava-parent:33.3.1-jre:guava-parent-33.3.1-jre.pom',
  'org.junit:junit-bom:5.10.2:junit-bom-5.10.2.module',
  'org.jetbrains.kotlinx:kotlinx-coroutines-bom:1.8.0:kotlinx-coroutines-bom-1.8.0.pom'
];
const platformCleanRunArtifactCoordinates = {
  phone: [
    'com.android.tools.build:gradle:9.2.1:gradle-9.2.1.jar',
    'com.android.tools.build:gradle:9.2.1:gradle-9.2.1.module',
    'com.facebook.react:react-android:0.88.0:react-android-0.88.0-release.aar',
    'com.android.tools.lint:lint-gradle:32.2.1:lint-gradle-32.2.1.jar',
    'com.android.tools.lint:lint-gradle:32.2.1:lint-gradle-32.2.1.pom',
    'com.android.tools.lint:lint-checks:32.2.1:lint-checks-32.2.1.jar',
    'com.android.tools.lint:lint-checks:32.2.1:lint-checks-32.2.1.pom',
    'com.google.devtools.ksp:symbol-processing-aa-embeddable:2.2.10-2.0.2:symbol-processing-aa-embeddable-2.2.10-2.0.2.jar',
    'com.google.devtools.ksp:symbol-processing-aa-embeddable:2.2.10-2.0.2:symbol-processing-aa-embeddable-2.2.10-2.0.2.pom',
    'com.android.tools.build:aapt2:9.2.1-15009934:aapt2-9.2.1-15009934-linux.jar',
    'com.android.tools.build:aapt2:9.2.1-15009934:aapt2-9.2.1-15009934-windows.jar',
    'com.android.tools.build:aapt2:9.2.1-15009934:aapt2-9.2.1-15009934.pom',
    'com.android.tools:play-sdk-proto:32.2.1:play-sdk-proto-32.2.1.jar',
    'com.android.tools:play-sdk-proto:32.2.1:play-sdk-proto-32.2.1.pom',
    'com.android.tools.external.com-intellij:intellij-core:32.2.1:intellij-core-32.2.1.jar',
    'com.android.tools.external.com-intellij:intellij-core:32.2.1:intellij-core-32.2.1.pom',
    'com.android.tools.external.com-intellij:kotlin-compiler:32.2.1:kotlin-compiler-32.2.1.jar',
    'com.android.tools.external.com-intellij:kotlin-compiler:32.2.1:kotlin-compiler-32.2.1.pom',
    'com.android.tools.external.org-jetbrains:uast:32.2.1:uast-32.2.1.jar',
    'com.android.tools.external.org-jetbrains:uast:32.2.1:uast-32.2.1.pom',
    'com.android.tools.lint:lint:32.2.1:lint-32.2.1.jar',
    'com.android.tools.lint:lint:32.2.1:lint-32.2.1.pom',
    'com.android.tools.lint:lint-api:32.2.1:lint-api-32.2.1.jar',
    'com.android.tools.lint:lint-api:32.2.1:lint-api-32.2.1.pom',
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
    'org.junit:junit-bom:5.11.0-M2:junit-bom-5.11.0-M2.module'
  ],
  wear: [
    'com.android.tools.build:aapt2:8.11.0-12782657:aapt2-8.11.0-12782657-linux.jar',
    'com.android.tools.build:aapt2:8.11.0-12782657:aapt2-8.11.0-12782657-windows.jar',
    'com.android.tools.build:aapt2:8.11.0-12782657:aapt2-8.11.0-12782657.pom',
    'com.android.tools.lint:lint:31.11.0:lint-31.11.0.jar',
    'com.android.tools.lint:lint:31.11.0:lint-31.11.0.pom',
    'com.android.tools.lint:lint-gradle:31.11.0:lint-gradle-31.11.0.jar',
    'com.android.tools.lint:lint-gradle:31.11.0:lint-gradle-31.11.0.pom'
  ]
};

function verificationArtifactFixture(coordinate) {
  const [group, name, version, artifactName] = coordinate.split(':');
  return `    <component group="${group}" name="${name}" version="${version}"><artifact name="${artifactName}"><sha256 value="${fixtureSha256}" /></artifact></component>`;
}

const verificationMetadataFixture = [
  '<verification-metadata>',
  '  <configuration><verify-metadata>true</verify-metadata></configuration>',
  '  <components>',
  '    <component group="org.jetbrains.kotlin.jvm" name="org.jetbrains.kotlin.jvm.gradle.plugin" version="2.1.20">',
  `      <artifact name="org.jetbrains.kotlin.jvm.gradle.plugin-2.1.20.pom"><sha256 value="${fixtureSha256}" /></artifact>`,
  '    </component>',
  '    <component group="com.android.application" name="com.android.application.gradle.plugin" version="8.11.0">',
  `      <artifact name="com.android.application.gradle.plugin-8.11.0.pom"><sha256 value="${fixtureSha256}" /></artifact>`,
  '    </component>',
  verificationArtifactFixture('org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.20:kotlin-gradle-plugin-2.1.20-gradle85.jar'),
  verificationArtifactFixture('example:dependency:1.0:dependency-1.0.module'),
  verificationArtifactFixture('com.google.android.gms:play-services-wearable:20.0.1:play-services-wearable-20.0.1.aar'),
  verificationArtifactFixture('androidx.room:room-runtime:2.7.0:room-runtime.aar'),
  verificationArtifactFixture('androidx.compose:compose-bom:2026.06.00:compose-bom-2026.06.00.pom'),
  ...commonCleanRunArtifactCoordinates.map(verificationArtifactFixture),
  ...platformCleanRunArtifactCoordinates.phone.map(verificationArtifactFixture),
  ...platformCleanRunArtifactCoordinates.wear.map(verificationArtifactFixture),
  '  </components>',
  '</verification-metadata>',
  ''
].join('\n');

function gradleStateSha256(bytes) {
  return crypto.createHash('sha256')
    .update(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'))
    .digest('hex');
}

function writeGradleDependencyStateFixture(root, label) {
  const files = label === 'phone'
    ? [
        'buildscript-gradle.lockfile',
        'settings-gradle.lockfile',
        'gradle/dependency-locks/app.lockfile',
        'gradle/verification-metadata.xml'
      ]
    : [
        'app/gradle.lockfile',
        'settings-gradle.lockfile',
        'gradle/verification-metadata.xml'
      ];
  for (const relativePath of files) {
    const file = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      relativePath.endsWith('verification-metadata.xml')
        ? verificationMetadataFixture
        : gradleLockFixture
    );
  }
  fs.writeFileSync(
    path.join(root, label === 'phone' ? 'build.gradle' : 'build.gradle.kts'),
    label === 'phone'
      ? 'lockAllConfigurations()\nLockMode.STRICT\ngradle/dependency-locks/'
      : 'lockAllConfigurations()\nLockMode.STRICT'
  );
  const records = files.map((relativePath) => ({
    path: relativePath,
    sha256: gradleStateSha256(fs.readFileSync(path.join(root, ...relativePath.split('/'))))
  }));
  return {
    schemaVersion: 1,
    platforms: { [label]: { files: records } }
  };
}

test('tracked phone and Wear dependency state is complete and hash-reviewed', () => {
  const manifest = JSON.parse(fs.readFileSync(
    new URL('../mobile/gradle/native-release/integrity.json', import.meta.url),
    'utf8'
  ));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.platforms.phone.files.length, 31);
  for (const module of ['expo-dev-client', 'expo-dev-launcher', 'expo-dev-menu', 'expo-dev-menu-interface']) {
    assert.ok(manifest.platforms.phone.files.some((file) => file.path === `gradle/dependency-locks/${module}.lockfile`));
  }
  assert.ok(manifest.platforms.phone.files.some((file) => file.path.endsWith('expo-dom-webview.lockfile')));
  assert.equal(manifest.platforms.wear.files.length, 3);

  for (const [label, relativeRoot] of [
    ['phone', '../mobile/gradle/native-release/phone'],
    ['wear', '../wear']
  ]) {
    const reviewedRoot = fileURLToPath(new URL(relativeRoot, import.meta.url));
    const paths = new Set();
    for (const record of manifest.platforms[label].files) {
      assert.equal(paths.has(record.path), false);
      paths.add(record.path);
      assert.equal(
        gradleStateSha256(fs.readFileSync(path.join(reviewedRoot, ...record.path.split('/')))),
        record.sha256,
        `${label} ${record.path}`
      );
    }
    const metadata = fs.readFileSync(
      path.join(reviewedRoot, 'gradle', 'verification-metadata.xml'),
      'utf8'
    );
    assert.doesNotThrow(() => assertNativeReleaseVerificationMetadata(label, metadata));
    assert.ok(paths.has('gradle/verification-metadata.xml'));
    assert.ok([...paths].some((entry) => entry.endsWith('.lockfile')));
  }
});

test('Gradle integrity hashes canonical Git blobs across LF and CRLF checkouts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-gradle-line-endings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = writeGradleDependencyStateFixture(root, 'wear');
  const build = { label: 'wear', cwd: root };

  for (const record of manifest.platforms.wear.files) {
    const file = path.join(root, ...record.path.split('/'));
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  }
  assert.doesNotThrow(() => assertNativeReleaseGradleDependencyState(build, { manifest }));

  const metadata = path.join(root, 'gradle', 'verification-metadata.xml');
  fs.appendFileSync(metadata, '<!-- content mutation -->\r\n');
  assert.throws(
    () => assertNativeReleaseGradleDependencyState(build, { manifest }),
    /reviewed Gradle dependency state changed: gradle\/verification-metadata\.xml/
  );
});

test('verification metadata rejects trust shortcuts and incomplete artifact checksums', () => {
  assert.throws(
    () => assertNativeReleaseVerificationMetadata(
      'phone',
      verificationMetadataFixture.replace(
        '<components>',
        '<trusted-artifacts></trusted-artifacts><components>'
      )
    ),
    /without trust or ignore shortcuts/
  );
  assert.throws(
    () => assertNativeReleaseVerificationMetadata(
      'wear',
      verificationMetadataFixture.replace(
        '<components>',
        '<key-servers><key-server uri="https://keys.invalid" /></key-servers><components>'
      )
    ),
    /without trust or ignore shortcuts/
  );
  assert.throws(
    () => assertNativeReleaseVerificationMetadata(
      'wear',
      verificationMetadataFixture.replace(
        `<sha256 value="${fixtureSha256}" />`,
        `<sha256 value="${fixtureSha256}" /><sha256 value="${'b'.repeat(64)}" />`
      )
    ),
    /every artifact exactly one 64-hex SHA-256/
  );
  assert.throws(
    () => assertNativeReleaseVerificationMetadata(
      'phone',
      verificationMetadataFixture.replace(fixtureSha256, 'not-a-sha256')
    ),
    /every artifact exactly one 64-hex SHA-256/
  );
});

test('verification metadata requires exact clean-run artifacts for each native platform', () => {
  for (const label of ['phone', 'wear']) {
    for (const coordinate of [
      ...commonCleanRunArtifactCoordinates,
      ...platformCleanRunArtifactCoordinates[label]
    ]) {
      const artifactRecord = verificationArtifactFixture(coordinate);
      assert.throws(
        () => assertNativeReleaseVerificationMetadata(
          label,
          verificationMetadataFixture.replace(artifactRecord, '')
        ),
        /omits representative plugin or clean-run release artifacts/
      );
    }
  }

  for (const coordinate of platformCleanRunArtifactCoordinates.phone) {
    const artifactRecord = verificationArtifactFixture(coordinate);
    assert.doesNotThrow(() => assertNativeReleaseVerificationMetadata(
      'wear',
      verificationMetadataFixture.replace(artifactRecord, '')
    ));
  }

  const phoneAapt2Linux =
    'com.android.tools.build:aapt2:9.2.1-15009934:aapt2-9.2.1-15009934-linux.jar';
  const liveRecord = verificationArtifactFixture(phoneAapt2Linux);
  assert.throws(
    () => assertNativeReleaseVerificationMetadata(
      'phone',
      verificationMetadataFixture.replace(liveRecord, `<!-- ${liveRecord} -->`)
    ),
    /must not contain XML comments/
  );

  const phoneAapt2Windows =
    'com.android.tools.build:aapt2:9.2.1-15009934:aapt2-9.2.1-15009934-windows.jar';
  const wrongComponent =
    'com.android.tools.build:aapt2-proto:7.3.1-8691043:aapt2-9.2.1-15009934-windows.jar';
  assert.throws(
    () => assertNativeReleaseVerificationMetadata(
      'phone',
      verificationMetadataFixture.replace(
        verificationArtifactFixture(phoneAapt2Windows),
        verificationArtifactFixture(wrongComponent)
      )
    ),
    /omits representative plugin or clean-run release artifacts/
  );
});

test('native release rejects missing or mutated verification metadata and lock state', (t) => {
  for (const label of ['phone', 'wear']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `calibrate-${label}-gradle-state-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifest = writeGradleDependencyStateFixture(root, label);
    const build = { label, cwd: root };
    const metadata = path.join(root, 'gradle', 'verification-metadata.xml');
    const lock = path.join(
      root,
      ...(label === 'phone'
        ? ['gradle', 'dependency-locks', 'app.lockfile']
        : ['app', 'gradle.lockfile'])
    );

    assert.doesNotThrow(() => assertNativeReleaseGradleDependencyState(build, { manifest }));
    fs.appendFileSync(metadata, '<!-- mutation -->\n');
    assert.throws(
      () => assertNativeReleaseGradleDependencyState(build, { manifest }),
      /reviewed Gradle dependency state changed: gradle\/verification-metadata\.xml/
    );

    fs.writeFileSync(metadata, verificationMetadataFixture);
    fs.appendFileSync(lock, 'mutated:dependency:2.0=releaseRuntimeClasspath\n');
    assert.throws(
      () => assertNativeReleaseGradleDependencyState(build, { manifest }),
      /reviewed Gradle dependency state changed: .*\.lockfile/
    );

    fs.writeFileSync(lock, gradleLockFixture);
    fs.rmSync(lock);
    assert.throws(
      () => assertNativeReleaseGradleDependencyState(build, { manifest }),
      /reviewed Gradle dependency state is missing: .*\.lockfile/
    );

    fs.writeFileSync(lock, gradleLockFixture);
    fs.writeFileSync(
      path.join(root, label === 'phone' ? 'build.gradle' : 'build.gradle.kts'),
      'lockAllConfigurations()'
    );
    assert.throws(
      () => assertNativeReleaseGradleDependencyState(build, { manifest }),
      /dependency locking must use complete state in LockMode\.STRICT/
    );
  }
});

test('native release accepts only the reviewed phone and Wear Gradle wrapper code', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-gradle-wrapper-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const phoneRoot = path.join(fixture, 'phone');
  const wearRoot = path.join(fixture, 'wear');
  writeGradleWrapperFixture(phoneRoot);
  writeGradleWrapperFixture(wearRoot, { label: 'wear' });

  assert.doesNotThrow(() => assertNativeReleaseGradleWrapper({ label: 'phone', cwd: phoneRoot }));
  assert.doesNotThrow(() => assertNativeReleaseGradleWrapper({ label: 'wear', cwd: wearRoot }));
  assert.doesNotThrow(() => assertNativeReleaseGradleWrapper({
    label: 'wear',
    cwd: fileURLToPath(new URL('../wear', import.meta.url))
  }));
  assert.equal(
    crypto.createHash('sha256').update(officialGradleWrapperJar).digest('hex'),
    NATIVE_RELEASE_GRADLE_WRAPPER_JAR_SHA256
  );
  assert.throws(() => assertNativeReleaseGradleWrapper({ label: 'phone', cwd: wearRoot }), /must pin distributionUrl/);
  assert.throws(() => assertNativeReleaseGradleWrapper({ label: 'wear', cwd: phoneRoot }), /must pin distributionUrl/);
});

test('native release rejects missing or changed Gradle URL, checksum, and wrapper JAR', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-gradle-wrapper-invalid-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const build = { label: 'phone', cwd: fixture };
  const propertiesFile = path.join(fixture, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  const wrapperJar = path.join(fixture, 'gradle', 'wrapper', 'gradle-wrapper.jar');

  writeGradleWrapperFixture(fixture, { omitProperties: true });
  assert.throws(() => assertNativeReleaseGradleWrapper(build), /wrapper properties are missing/);

  fs.writeFileSync(propertiesFile, 'distributionSha256Sum=0\n');
  assert.throws(() => assertNativeReleaseGradleWrapper(build), /must pin distributionUrl/);

  fs.writeFileSync(propertiesFile, canonicalGradleWrapperProperties({
    distributionUrl: 'https\\://example.invalid/gradle-8.14.3-bin.zip'
  }));
  assert.throws(() => assertNativeReleaseGradleWrapper(build), /must pin distributionUrl/);

  fs.writeFileSync(propertiesFile, canonicalGradleWrapperProperties({ omitChecksum: true }));
  assert.throws(() => assertNativeReleaseGradleWrapper(build), /must pin distributionSha256Sum/);

  fs.writeFileSync(propertiesFile, canonicalGradleWrapperProperties({
    distributionSha256Sum: '0'.repeat(64)
  }));
  assert.throws(() => assertNativeReleaseGradleWrapper(build), /must pin distributionSha256Sum/);

  fs.writeFileSync(propertiesFile, canonicalGradleWrapperProperties());
  fs.rmSync(wrapperJar);
  assert.throws(() => assertNativeReleaseGradleWrapper(build), /wrapper JAR is missing/);

  fs.writeFileSync(wrapperJar, 'not the reviewed Gradle wrapper');
  assert.throws(
    () => assertNativeReleaseGradleWrapper(build),
    /wrapper JAR SHA-256 .* does not match the reviewed Gradle 9\.4\.1 wrapper JAR/
  );
});

test('native release verifies both wrappers before cache eviction', () => {
  const builds = [{ label: 'phone' }, { label: 'wear' }];
  const events = [];
  const removed = prepareNativeReleaseGradleExecution(builds, {}, {
    assertWrapper: (build) => events.push(`verify:${build.label}`),
    assertDependencyState: (build) => events.push(`state:${build.label}`),
    removeDistributionCache: (_environment, options) => {
      events.push(`remove:${options.label}`);
      return `${options.label}-distribution-cache`;
    }
  });
  assert.deepEqual(removed, ['phone-distribution-cache', 'wear-distribution-cache']);
  assert.deepEqual(events, [
    'verify:phone',
    'verify:wear',
    'state:phone',
    'state:wear',
    'remove:phone',
    'remove:wear'
  ]);

  events.length = 0;
  assert.throws(
    () => prepareNativeReleaseGradleExecution(builds, {}, {
      assertWrapper: (build) => {
        events.push(`verify:${build.label}`);
        if (build.label === 'wear') throw new Error('invalid Wear wrapper');
      },
      assertDependencyState: (build) => events.push(`state:${build.label}`),
      removeDistributionCache: () => events.push('remove:distribution')
    }),
    /invalid Wear wrapper/
  );
  assert.deepEqual(events, ['verify:phone', 'verify:wear']);
});

test('native release evicts only the exact pinned distribution and preserves dependency caches', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-gradle-cache-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const gradleUserHome = path.join(fixture, 'gradle-user-home');
  const environment = { GRADLE_USER_HOME: gradleUserHome };
  const distributionCache = nativeReleaseGradleDistributionCachePath(environment);
  const dependencySentinel = path.join(gradleUserHome, 'caches', 'modules-2', 'dependency.bin');
  const adjacentDistribution = path.join(
    gradleUserHome,
    'wrapper',
    'dists',
    'gradle-8.14.3-all',
    'adjacent.bin'
  );
  fs.mkdirSync(distributionCache, { recursive: true });
  fs.mkdirSync(path.dirname(dependencySentinel), { recursive: true });
  fs.mkdirSync(path.dirname(adjacentDistribution), { recursive: true });
  fs.writeFileSync(path.join(distributionCache, 'cached-distribution.zip'), 'stale');
  fs.writeFileSync(dependencySentinel, 'verified dependency cache');
  fs.writeFileSync(adjacentDistribution, 'other distribution');

  assert.equal(removeNativeReleaseGradleDistributionCache(environment), distributionCache);
  assert.equal(fs.existsSync(distributionCache), false);
  assert.equal(fs.readFileSync(dependencySentinel, 'utf8'), 'verified dependency cache');
  assert.equal(fs.readFileSync(adjacentDistribution, 'utf8'), 'other distribution');
  assert.doesNotThrow(() => removeNativeReleaseGradleDistributionCache(environment));
  assert.equal(
    nativeReleaseGradleDistributionCachePath({}, { homeDirectory: fixture }),
    path.join(fixture, '.gradle', 'wrapper', 'dists', 'gradle-9.4.1-bin')
  );
  assert.equal(
    nativeReleaseGradleDistributionCachePath({}, { homeDirectory: fixture, label: 'wear' }),
    path.join(fixture, '.gradle', 'wrapper', 'dists', 'gradle-8.14.3-bin')
  );
});

test('native release builds require freshly generated APK and AAB outputs', () => {
  const build = { label: 'phone', cwd: 'C:/repo/mobile/android' };
  const artifacts = nativeReleaseArtifactPaths(build);
  assert.match(artifacts[0], /outputs[\\/]apk[\\/]release[\\/]app-release\.apk$/);
  assert.match(artifacts[1], /outputs[\\/]bundle[\\/]release[\\/]app-release\.aab$/);

  const removed = [];
  prepareNativeReleaseArtifacts(build, (file) => removed.push(file));
  assert.deepEqual(removed, artifacts);
  assert.doesNotThrow(() => assertNativeReleaseArtifacts(build, () => true));
  assert.throws(
    () => assertNativeReleaseArtifacts(build, (file) => file.endsWith('.apk')),
    /phone Gradle completed without producing.*app-release\.aab.*masked daemon, lint, or memory failure/s
  );
});

test('native release build regenerates the ignored phone project before Gradle', () => {
  const command = nativeReleasePrebuildCommand('C:/repo');

  assert.equal(command.label, 'phone prebuild');
  assert.match(command.cwd, /repo[\\/]mobile$/);
  assert.match(command.args[0], /node_modules[\\/]expo[\\/]bin[\\/]cli$/);
  assert.deepEqual(command.args.slice(1), [
    'prebuild',
    '--platform',
    'android',
    '--clean',
    '--no-install'
  ]);
});

test('Windows release builds bypass the command shell', () => {
  const build = nativeReleaseGradleCommands('win32')[0];
  const invocation = nativeReleaseInvocation(build, build.args, { JAVA_HOME: 'C:/Java' }, 'win32');

  assert.match(invocation.command, /Java[\\/]bin[\\/]java\.exe$/);
  assert.equal(invocation.args[0], '-classpath');
  assert.match(invocation.args[1], /gradle[\\/]wrapper[\\/]gradle-wrapper\.jar$/);
  assert.equal(invocation.args[2], 'org.gradle.wrapper.GradleWrapperMain');
  assert.ok(invocation.args.includes(':app:bundleRelease'));
});
test('native release build provenance requires a clean commit-specific source', () => {
  const sourceCommit = 'a'.repeat(40);
  const cleanGit = (_command, args) => args[0] === 'rev-parse' ? `${sourceCommit}\n` : '';
  assert.equal(readNativeReleaseBuildSource('C:/repo', cleanGit), sourceCommit);
  assert.throws(
    () => readNativeReleaseBuildSource('C:/repo', (_command, args) =>
      args[0] === 'rev-parse' ? `${sourceCommit}\n` : ' M shared/release.json\n'
    ),
    /clean worktree and index/
  );
  assert.throws(
    () => readNativeReleaseBuildSource('C:/repo', (_command, args) =>
      args[0] === 'rev-parse' ? 'not-a-commit\n' : ''
    ),
    /lowercase 40-character Git SHA/
  );
});

test('candidate-bound sidecar records and revalidates all four artifact bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-native-provenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceCommit = 'a'.repeat(40);
  const manifest = {
    android: {
      application_id: 'net.darkmachines.healthtracker',
      mobile: { version_name: '1.2.3', version_code: 12 },
      wear: { version_name: '1.2.4', version_code: 13 }
    }
  };
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
  const manifestContent = `${JSON.stringify(manifest)}\n`;
  fs.writeFileSync(path.join(root, 'shared', 'release.json'), manifestContent);
  for (const contract of NATIVE_RELEASE_ARTIFACT_CONTRACTS) {
    const file = path.join(root, contract.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `candidate-bytes-${contract.id}`);
  }

  assert.throws(
    () => readNativeReleaseBuildProvenance(root, { candidateCommit: sourceCommit }),
    (error) => {
      assert.match(error.message, /missing or invalid at build\/native-release-provenance\.json/);
      assert.equal(error.message.includes(root), false);
      return true;
    }
  );
  const provenance = createNativeReleaseBuildProvenance(root, sourceCommit);
  assert.equal(provenance.sourceCommit, sourceCommit);
  assert.equal(provenance.artifacts.length, 4);
  assert.ok(provenance.artifacts.every((artifact) => !path.isAbsolute(artifact.path)));
  assert.equal(writeNativeReleaseBuildProvenance(root, provenance), NATIVE_RELEASE_BUILD_PROVENANCE_PATH);
  assert.equal(fs.existsSync(path.join(root, NATIVE_RELEASE_BUILD_PROVENANCE_PATH)), true);

  const inspected = provenance.artifacts.map((artifact) => ({
    ...artifact,
    signerSha256: 'f'.repeat(64)
  }));
  assert.deepEqual(
    readNativeReleaseBuildProvenance(root, {
      candidateCommit: sourceCommit,
      manifestContent,
      artifacts: inspected
    }),
    provenance
  );
  assert.throws(
    () => readNativeReleaseBuildProvenance(root, {
      candidateCommit: 'b'.repeat(40),
      manifestContent,
      artifacts: inspected
    }),
    /sourceCommit does not match candidate C/
  );
  const oldArtifacts = inspected.map((artifact) => artifact.id === 'phone-apk'
    ? { ...artifact, sha256: '0'.repeat(64) }
    : artifact);
  assert.throws(
    () => readNativeReleaseBuildProvenance(root, {
      candidateCommit: sourceCommit,
      manifestContent,
      artifacts: oldArtifacts
    }),
    /phone-apk sha256 does not match the independently inspected artifact/
  );
});
