/** @file Calibrate paired APK/AAB application identity, signing and original-build verification. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  NATIVE_RELEASE_BUILD_PROVENANCE_PATH,
  readNativeReleaseBuildProvenance
} from './native-release-build.mjs';
import {
  NATIVE_RELEASE_APPLICATION_ID,
  NATIVE_RELEASE_ARTIFACT_CONTRACTS,
  parseKeytoolSignerFingerprint
} from './native-release-evidence.mjs';
import {
  parseAabManifestMetadata,
  parseApkBadging,
  parseSignerFingerprint,
  resolveNativeReleaseDeviceTooling
} from './native-release-devices.mjs';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_PLAY_APPLICATION_ID = NATIVE_RELEASE_APPLICATION_ID;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** Bind artifact and manifest bytes to stable release evidence. */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Translate Play's phone/watch roles to the manifest's client keys. */
function roleManifestKey(role) {
  return role === 'phone' ? 'mobile' : 'wear';
}

/** Resolve the reserved version identity for one form factor. */
function expectedVersion(manifest, role) {
  const version = manifest?.android?.[roleManifestKey(role)];
  return {
    versionName: version?.version_name,
    versionCode: version?.version_code
  };
}

/** Preserve manifest bytes alongside parsed values for provenance checks. */
function readReleaseManifest(root) {
  const file = path.join(root, 'shared', 'release.json');
  let content;
  let manifest;
  try {
    content = fs.readFileSync(file);
    manifest = JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error('shared/release.json is missing or invalid JSON.');
  }
  return { content, manifest };
}

/** Remove Play authentication from package inspection subprocesses. */
function artifactInspectionEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment ?? {}).filter(([name]) => {
    const normalized = name.toUpperCase();
    return !normalized.startsWith('GOOGLE_PLAY_') && normalized !== 'GOOGLE_APPLICATION_CREDENTIALS';
  }));
}

/** Bound inspection output and replace subprocess failures with actionable errors. */
function runArtifactInspection(execute, command, args, errorMessage, environment) {
  try {
    return execute(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: environment
    }).toString();
  } catch {
    throw new Error(errorMessage);
  }
}

/** Read package identity and signing certificates using pinned Android tooling. */
function inspectNativePlayArtifact(file, contract, options = {}) {
  const execute = options.execute ?? execFileSync;
  const environment = artifactInspectionEnvironment(options.environment ?? process.env);
  const tooling = options.tooling ?? resolveNativeReleaseDeviceTooling(environment);
  if (contract?.format === 'apk') {
    const badging = runArtifactInspection(
      execute,
      tooling.aapt,
      ['dump', 'badging', file],
      `Unable to inspect ${contract.id} package metadata with aapt.`,
      environment
    );
    const signing = runArtifactInspection(
      execute,
      tooling.java,
      ['-jar', tooling.apksignerJar, 'verify', '--print-certs', file],
      `Unable to inspect ${contract.id} signing certificate with apksigner.`,
      environment
    );
    return {
      ...parseApkBadging(badging),
      signerSha256: parseSignerFingerprint(signing)
    };
  }
  if (contract?.format === 'aab') {
    if (!tooling.bundletoolJar) {
      throw new Error(
        'BUNDLETOOL_JAR must point to the official bundletool all-in-one JAR for AAB metadata inspection.'
      );
    }
    const manifest = runArtifactInspection(
      execute,
      tooling.java,
      ['-jar', tooling.bundletoolJar, 'dump', 'manifest', `--bundle=${file}`],
      `Unable to inspect ${contract.id} manifest metadata with bundletool.`,
      environment
    );
    const signing = runArtifactInspection(
      execute,
      tooling.keytool,
      ['-J-Duser.language=en', '-J-Duser.country=US', '-printcert', '-jarfile', file],
      `Unable to inspect ${contract.id} signing certificate with keytool.`,
      environment
    );
    return {
      ...parseAabManifestMetadata(manifest),
      signerSha256: parseKeytoolSignerFingerprint(signing)
    };
  }
  throw new Error(`Unsupported native release artifact format: ${contract?.format ?? '(missing)'}.`);
}

/** Match all four signed packages to the manifest and original build provenance. */
export function verifyNativeArtifacts(options = {}) {
  const root = options.root ?? repositoryRoot;
  const plan = options.plan ?? { sourceCommit: options.sourceCommit, applicationId: NATIVE_RELEASE_APPLICATION_ID };
  const { content: manifestContent, manifest } = readReleaseManifest(root);
  let tooling = options.tooling;
  const artifactInspector = options.artifactInspector ?? ((file, contract) => {
    tooling ??= resolveNativeReleaseDeviceTooling(options.environment ?? process.env);
    return inspectNativePlayArtifact(file, contract, {
      execute: options.execute,
      tooling,
      environment: options.environment ?? process.env
    });
  });
  const inspectedArtifacts = NATIVE_RELEASE_ARTIFACT_CONTRACTS.map((contract) => {
    const file = path.resolve(root, contract.path);
    let stat;
    let bytes;
    try {
      stat = fs.statSync(file);
      bytes = fs.readFileSync(file);
    } catch {
      throw new Error(`${contract.id} release artifact is missing at ${contract.path}.`);
    }
    if (!stat.isFile() || stat.size < 1) {
      throw new Error(`${contract.id} release artifact must be a non-empty file at ${contract.path}.`);
    }
    let inspection;
    try {
      inspection = artifactInspector(file, contract);
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(`Unable to inspect ${contract.id} release artifact.`);
    }
    if (inspection?.applicationId !== NATIVE_PLAY_APPLICATION_ID) {
      throw new Error(`${contract.id} application ID must be ${NATIVE_PLAY_APPLICATION_ID}.`);
    }
    const expected = expectedVersion(manifest, contract.role);
    if (
      inspection?.versionName !== expected.versionName ||
      inspection?.versionCode !== expected.versionCode
    ) {
      throw new Error(`${contract.id} version does not match shared/release.json.`);
    }
    const signerSha256 = inspection?.signerSha256?.replaceAll(':', '').toLowerCase();
    if (!SHA256_PATTERN.test(signerSha256 ?? '')) {
      throw new Error(`${contract.id} signing certificate SHA-256 is invalid.`);
    }
    return {
      ...contract,
      sizeBytes: stat.size,
      sha256: sha256(bytes),
      applicationId: inspection.applicationId,
      versionName: inspection.versionName,
      versionCode: inspection.versionCode,
      signerSha256
    };
  });

  const provenance = readNativeReleaseBuildProvenance(root, {
    candidateCommit: plan.sourceCommit,
    manifestContent,
    artifacts: inspectedArtifacts
  });

  const signers = new Set(inspectedArtifacts.map(({ signerSha256 }) => signerSha256));
  if (signers.size !== 1) {
    throw new Error('Phone and Wear APK/AAB artifacts must share one signing certificate.');
  }

  return {
    sourceCommit: plan.sourceCommit,
    applicationId: plan.applicationId,
    releaseManifestSha256: sha256(manifestContent),
    buildProvenancePath: NATIVE_RELEASE_BUILD_PROVENANCE_PATH,
    signerSha256: inspectedArtifacts[0].signerSha256,
    artifacts: inspectedArtifacts
  };
}

