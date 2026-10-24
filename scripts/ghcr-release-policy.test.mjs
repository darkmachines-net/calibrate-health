/** @file Regression coverage for ghcr release policy: accepts only single OCI or Docker linux/amd64 image manifests. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isExplicitRegistryAbsence,
  MULTI_PLATFORM_MEDIA_TYPES,
  SINGLE_MANIFEST_MEDIA_TYPES,
  validateSingleAmd64Manifest
} from './ghcr-release-policy.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const imageConfig = { os: 'linux', architecture: 'amd64' };

function manifest(mediaType) {
  return {
    schemaVersion: 2,
    mediaType,
    config: { digest, mediaType: 'application/vnd.oci.image.config.v1+json' },
    layers: []
  };
}

test('accepts only single OCI or Docker linux/amd64 image manifests', () => {
  for (const mediaType of SINGLE_MANIFEST_MEDIA_TYPES) {
    assert.deepEqual(validateSingleAmd64Manifest(manifest(mediaType), imageConfig), {
      mediaType,
      configDigest: digest,
      os: 'linux',
      architecture: 'amd64'
    });
  }
});

test('rejects both OCI indexes and Docker manifest lists', () => {
  for (const mediaType of MULTI_PLATFORM_MEDIA_TYPES) {
    assert.throws(
      () => validateSingleAmd64Manifest(manifest(mediaType), imageConfig),
      /multi-platform index\/list/
    );
  }
});

test('rejects non-linux, non-amd64, malformed, and unsupported single manifests', () => {
  assert.throws(
    () => validateSingleAmd64Manifest(manifest(SINGLE_MANIFEST_MEDIA_TYPES[0]), { os: 'linux', architecture: 'arm64' }),
    /must be linux\/amd64/
  );
  assert.throws(
    () => validateSingleAmd64Manifest({ ...manifest(SINGLE_MANIFEST_MEDIA_TYPES[0]), schemaVersion: 1 }, imageConfig),
    /schemaVersion 2/
  );
  const missingConfig = manifest(SINGLE_MANIFEST_MEDIA_TYPES[0]);
  missingConfig.config = null;
  assert.throws(() => validateSingleAmd64Manifest(missingConfig, imageConfig), /config descriptor/);
  assert.throws(
    () => validateSingleAmd64Manifest(manifest('application/example'), imageConfig),
    /unsupported manifest media type/
  );
});

test('only the exact requested GHCR ref absence response classifies an alias as absent', () => {
  const imageRef = 'ghcr.io/mchartier/calibratehealth:v9.8.7';
  assert.equal(isExplicitRegistryAbsence(`ERROR: ${imageRef}: not found`, imageRef), true);
  assert.equal(isExplicitRegistryAbsence(`ERROR: ${imageRef}: manifest unknown\n`, imageRef), true);
  assert.equal(isExplicitRegistryAbsence('ERROR: ghcr.io/mchartier/calibratehealth:v1.0.0: not found', imageRef), false);
  assert.equal(isExplicitRegistryAbsence('builder instance default not found', imageRef), false);
  assert.equal(isExplicitRegistryAbsence('docker credential helper not found', imageRef), false);
  assert.equal(isExplicitRegistryAbsence(`ERROR: failed to solve: ${imageRef}: not found`, imageRef), false);
  assert.equal(isExplicitRegistryAbsence('repository access denied', imageRef), false);
  assert.throws(() => isExplicitRegistryAbsence(`ERROR: ${imageRef}: not found`, 'not-an-image'), /malformed/);
});

test('publisher can replace legacy latest indexes without adopting them as immutable release evidence', {
  skip: process.platform === 'win32' ? 'The publisher shell runs on the native Linux Actions lane.' : false
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-latest-shell-'));
  const workflow = fs.readFileSync(new URL('../.github/workflows/container.yml', import.meta.url), 'utf8');
  const helpers = workflow.slice(workflow.indexOf('          inspect_reference_digest()'), workflow.indexOf('          config_digest_for_manifest()'));
  assert.match(helpers, /inspect_digest\(\)/);
  const mockDocker = `
docker() {
  if [[ "$LOOKUP_MODE" == "denied" ]]; then echo 'unauthorized' >&2; return 1; fi
  case "$*" in
    *'{{.Manifest.Digest}}'*) printf '%s' "$MANIFEST_DIGEST" ;;
    *--raw*) printf '%s' '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}' ;;
    *'{{json .Image}}'*) printf '%s' '{"os":"linux","architecture":"amd64"}' ;;
    *) return 1 ;;
  esac
}
`;
  try {
    const toolingDirectory = path.join(directory, '.release-tooling', 'scripts');
    fs.mkdirSync(toolingDirectory, { recursive: true });
    fs.copyFileSync(new URL('./ghcr-release-policy.mjs', import.meta.url), path.join(toolingDirectory, 'ghcr-release-policy.mjs'));
    const run = (command, lookupMode = 'ok') => spawnSync('bash', ['-c', `set -euo pipefail\n${mockDocker}\n${helpers}\n${command}`], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: directory, MANIFEST_DIGEST: digest, LOOKUP_MODE: lookupMode }
    });
    const latest = run('inspect_reference_digest ghcr.io/mchartier/calibratehealth:latest');
    assert.equal(latest.status, 0, latest.stderr);
    assert.equal(latest.stdout, digest);
    const immutable = run('inspect_digest ghcr.io/mchartier/calibratehealth:v0.36.0');
    assert.notEqual(immutable.status, 0);
    assert.match(immutable.stderr, /multi-platform index\/list/);
    const denied = run('inspect_reference_digest ghcr.io/mchartier/calibratehealth:latest', 'denied');
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /refusing to treat the failure as absence/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('shell composition captures the config digest and emits exactly one manifest digest line', {
  skip: process.platform === 'win32' ? 'The release shell regression runs on the native Linux Actions lane.' : false
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-policy-shell-'));
  const manifestFile = path.join(directory, 'manifest.json');
  const configFile = path.join(directory, 'config.json');
  const capturedConfig = path.join(directory, 'captured-config-digest');
  const policyFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ghcr-release-policy.mjs');
  const manifestDigest = `sha256:${'d'.repeat(64)}`;
  try {
    fs.writeFileSync(manifestFile, JSON.stringify(manifest(SINGLE_MANIFEST_MEDIA_TYPES[0])));
    fs.writeFileSync(configFile, JSON.stringify(imageConfig));
    const shell = [
      'set -euo pipefail',
      'config_digest="$("$NODE_BIN" "$POLICY_FILE" validate-manifest --manifest-file "$MANIFEST_FILE" --image-config-file "$CONFIG_FILE")"',
      'printf \'%s\\n\' "$config_digest" > "$CAPTURED_CONFIG"',
      'printf \'%s\\n\' "$MANIFEST_DIGEST"'
    ].join('\n');
    const result = spawnSync('bash', ['-c', shell], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAPTURED_CONFIG: capturedConfig,
        CONFIG_FILE: configFile,
        MANIFEST_DIGEST: manifestDigest,
        MANIFEST_FILE: manifestFile,
        NODE_BIN: process.execPath,
        POLICY_FILE: policyFile
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${manifestDigest}\n`);
    assert.equal(fs.readFileSync(capturedConfig, 'utf8'), `${digest}\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
