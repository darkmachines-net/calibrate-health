/** @file Select application publications from recorded component sources, never from a mutable latest build. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveExpoRuntime } from './expo-runtime.mjs';
import { compareSemver, nextReleaseVersion } from './release-config.mjs';
import { allocateCalibrateNativeCodes, selectCalibrateComponents } from './release-engine.mjs';

const IGNORED = /(^|\/)(__tests__|__mocks__|fixtures|e2e|docs)(\/|$)|(^|\/)src\/(test|androidTest)\/|\.(test|spec)\.[^/]+$|(^|\/)(README[^/]*|AGENTS\.md)$/i;
const SERVER_FILES = /^(backend\/|shared\/|packages\/|mobile\/|Dockerfile\.app$|\.dockerignore$|package(?:-lock)?\.json$|scripts\/expo-(?:cli-environment|web-build|web-release)\.mjs$)/;
const PHONE_FILES = /^(mobile\/|shared\/|packages\/api-client\/|package(?:-lock)?\.json$)/;

/** Read only tracked Git data, avoiding working-tree artifacts and inherited replacement objects. */
export function releaseGit(root, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    env: { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }
  }).trim();
}

/** Release mirrors change versions without changing the application inputs they describe. */
export function applicationContent(file, text) {
  if (file === 'shared/release.json') {
    const value = JSON.parse(text);
    return JSON.stringify({ api: value.server.api, major: value.server.version.split('.')[0],
      application_id: value.android.application_id, channels: value.android.channels,
      minimum_phone: value.android.mobile.minimum_supported_version,
      minimum_wear: value.android.wear.minimum_supported_version });
  }
  if (file === 'shared/client-diagnostic-versions.json') {
    const value = JSON.parse(text);
    delete value.previous_web_release;
    delete value.supported_versions.web;
    return JSON.stringify(value);
  }
  if (/(^|\/)package(?:-lock)?\.json$/.test(file)) {
    const value = JSON.parse(text);
    delete value.version;
    if (value.scripts) value.scripts = Object.fromEntries(Object.entries(value.scripts)
      .filter(([name]) => /^(pre|post)?(install|prepare|build(?::.*)?|start(?::.*)?)$/.test(name)));
    for (const [name, entry] of Object.entries(value.packages ?? {})) {
      if (!name.includes('node_modules')) delete entry.version;
    }
    return JSON.stringify(value);
  }
  if (file === 'backend/openapi/v1.yaml' || file === 'packages/api-client/src/generated/v1.ts') {
    return text.replace(/(version: ?)["']?\d+\.\d+\.\d+["']?/g, '$1<version>');
  }
  return text;
}

/** Classify source inputs conservatively, separating native-only modules from browser entrypoints. */
export function affectsComponent(file, component) {
  if (IGNORED.test(file)) return false;
  if (component === 'server') {
    return SERVER_FILES.test(file) && !/\.(native|android|ios)\.[^/]+$/.test(file)
      && !/^mobile\/(android|ios|gradle|plugins|modules)\//.test(file);
  }
  if (component === 'ota') {
    if (file === 'shared/client-diagnostic-versions.json') return false;
    return PHONE_FILES.test(file) && !/\.web\.[^/]+$/.test(file)
      && !/^mobile\/(public|android|ios|gradle)\//.test(file);
  }
  throw new Error(`Unknown component: ${component}`);
}

/** Find changed tracked paths relative to the last successful source for this component. */
function componentChanges(root, baseline, source, component) {
  if (!/^[a-f0-9]{40}$/.test(source) || (baseline && !/^[a-f0-9]{40}$/.test(baseline))) {
    throw new Error('Release comparisons require exact source commits.');
  }
  if (!baseline) return ['No recorded component publication'];
  releaseGit(root, ['merge-base', '--is-ancestor', baseline, source]);
  return releaseGit(root, ['diff', '--name-only', '--no-renames', baseline, source])
    .split(/\r?\n/).filter((file) => {
      if (!file || !affectsComponent(file, component)) return false;
      try {
        return applicationContent(file, releaseGit(root, ['show', `${baseline}:${file}`]))
          !== applicationContent(file, releaseGit(root, ['show', `${source}:${file}`]));
      } catch { return true; } // Added/deleted inputs still select their component.
    });
}

/** Hash Wear's tracked build inputs; phone compatibility is resolved by the installed Expo SDK. */
export function wearInputHash(root, source) {
  const files = releaseGit(root, ['ls-tree', '-r', '--name-only', source, '--', 'wear'])
    .split(/\r?\n/).filter((file) => file && !IGNORED.test(file) && !/^shared\/(release|client-diagnostic-versions)\.json$/.test(file));
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    const content = file === 'wear/app/build.gradle.kts'
      ? releaseGit(root, ['show', `${source}:${file}`]).replace(/versionCode = \d+/g, 'versionCode = <reserved>')
        .replace(/versionName = "[^"]+"/g, 'versionName = "<reserved>"')
      : releaseGit(root, ['rev-parse', `${source}:${file}`]);
    hash.update(`${file}\0${content}\0`);
  }
  return hash.digest('hex');
}

/** Make the publication dependency graph explicit and keep version bookkeeping out of detection. */
export function selectRelease({ manifest, baseline, serverChanges, otaChanges, productionChanges = otaChanges, runtimeVersion, wearHash, bump }) {
  if (!['patch', 'minor', 'major'].includes(bump)) throw new Error('Release bump must be patch, minor, or major.');
  const nativeBaseline = baseline?.native;
  const newRuntime = !nativeBaseline || nativeBaseline.runtime_version !== runtimeVersion;
  const native = newRuntime || nativeBaseline.wear_hash !== wearHash;
  const reserved = baseline?.reserved_native_version ?? nativeBaseline?.version;
  const minimumNativeCode = baseline?.reserved_native_code ?? 0;
  const reserveNative = native && (!reserved || compareSemver(manifest.android.mobile.version_name, reserved) <= 0 || manifest.android.mobile.version_code <= minimumNativeCode);
  const selected = selectCalibrateComponents({ serverChanges, otaChanges, productionChanges,
    phoneRuntimeChanged: newRuntime, wearChanged: !nativeBaseline || nativeBaseline.wear_hash !== wearHash,
    reserveNative, bump });
  const server = selected.server;
  const introducesRuntime = newRuntime || reserveNative;
  const ota = selected.ota_internal;
  const production = selected.ota_production;
  return {
    schema_version: 1,
    server, native, ota_internal: ota, ota_production: production,
    server_version: server ? nextReleaseVersion(manifest.server.version, bump) : null,
    reserve_native: reserveNative,
    minimum_native_code: minimumNativeCode,
    native_version: native ? (reserveNative ? nextReleaseVersion(manifest.android.mobile.version_name, 'patch') : manifest.android.mobile.version_name) : null,
    native_codes: native ? (reserveNative ? allocateCalibrateNativeCodes(manifest, minimumNativeCode) : {
      mobileVersionCode: manifest.android.mobile.version_code, wearVersionCode: manifest.android.wear.version_code
    }) : null,
    noop: selected.noop,
    selection: selected.selection,
    bump, runtime_version: runtimeVersion, wear_hash: wearHash,
    reasons: {
      server: [...serverChanges, ...(reserveNative ? ['Native version preparation updates server diagnostic metadata'] : [])],
      native: native ? [nativeBaseline ? 'Phone fingerprint or Wear build inputs changed' : 'No native baseline'] : [],
      ota_internal: [...otaChanges, ...(introducesRuntime ? ['New native runtime, including selected native version preparation'] : []), ...(server && bump === 'major' ? ['Server major contract changes'] : [])],
      ota_production: [...productionChanges, ...(introducesRuntime ? ['New native runtime, including selected native version preparation'] : []), ...(server && bump === 'major' ? ['Server major contract changes'] : [])]
    }
  };
}

/** Resolve the release snapshot with installed, credential-free native dependency discovery. */
export function inspectReleaseSelection(root, source, baseline, bump) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'shared/release.json'), 'utf8'));
  const fallbackServer = baseline?.server?.source_commit ?? releaseGit(root, ['rev-parse', `refs/tags/v${manifest.server.version}^{commit}`]);
  const resolvedBaseline = baseline ?? { server: { source_commit: fallbackServer } };
  return selectRelease({
    manifest, baseline: resolvedBaseline, bump,
    serverChanges: componentChanges(root, resolvedBaseline.server?.source_commit ?? fallbackServer, source, 'server'),
    otaChanges: componentChanges(root, resolvedBaseline.ota_internal?.source_commit, source, 'ota'),
    productionChanges: componentChanges(root, resolvedBaseline.ota_production?.source_commit, source, 'ota'),
    runtimeVersion: resolveExpoRuntime(root, { environment: { ...process.env, EXPO_UPDATES_CHANNEL: 'production' } }),
    wearHash: wearInputHash(root, source)
  });
}
