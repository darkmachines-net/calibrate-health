/** @file Inspect Calibrate's compiled phone/Wear origin and Android update configuration. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveNativeReleaseDeviceTooling } from './native-release-devices.mjs';

function metadataValue(xml, name) {
  const entry = (xml.match(/<meta-data\b[^>]*>/g) ?? []).find(value => value.includes(`android:name="${name}"`));
  return entry?.match(/android:value="([^"]*)"/)?.[1]?.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

export function parseBundleResourceValue(dump) {
  const values = [...dump.matchAll(/ - \[STR\] "([^"\r\n]*)"/g)].map(match => match[1]);
  if (!values.length || values.some(value => value !== values[0])) throw new Error('Bundle runtime resource must resolve to one consistent string value.');
  return values[0];
}

export function validateBundleRuntime(xml, { role, projectId, runtime, channel }, resolveResource = () => null) {
  if (!/android:usesCleartextTraffic="false"/.test(xml) || /android:debuggable="true"/.test(xml)) throw new Error(`${role} bundle must be a non-debuggable HTTPS-only release.`);
  if (role !== 'phone') return;
  for (const [name, expected] of Object.entries({ 'expo.modules.updates.EXPO_UPDATE_URL': `https://u.expo.dev/${projectId}`,
    'expo.modules.updates.EXPO_RUNTIME_VERSION': runtime })) {
    const raw = metadataValue(xml, name);
    const value = raw?.startsWith('@') || /^0x[0-9a-f]+$/i.test(raw ?? '') ? resolveResource(raw.replace(/^@/, '')) : raw;
    if (value !== expected) throw new Error(`Phone bundle has an unexpected ${name}.`);
  }
  const headers = JSON.parse(metadataValue(xml, 'expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY'));
  if (headers['expo-channel-name'] !== channel) throw new Error('Phone update channel differs from the selected profile.');
}

/** Read final AAB manifest plus compiled JS/DEX; build-time environment alone does not prove the embedded server. */
export function inspectBundleRuntime(file, expected, environment) {
  const tooling = resolveNativeReleaseDeviceTooling(environment);
  const run = (command, args, options = {}) => execFileSync(command, args, { env: environment, windowsHide: true,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, ...options });
  const xml = run(tooling.java, ['-jar', tooling.bundletoolJar, 'dump', 'manifest', `--bundle=${file}`]);
  validateBundleRuntime(xml, expected, resource => parseBundleResourceValue(run(tooling.java, ['-jar', tooling.bundletoolJar,
    'dump', 'resources', `--bundle=${file}`, `--resource=${resource}`, '--values'])));
  const jar = path.join(tooling.javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar');
  const entries = run(jar, ['tf', file]).split(/\r?\n/).filter(entry => expected.role === 'phone'
    ? entry === 'base/assets/index.android.bundle' : /^base\/dex\/classes\d*\.dex$/.test(entry));
  if (!entries.length) throw new Error('Bundle has no compiled application content.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-bundle-inspection-'));
  try {
    run(jar, ['xf', file, ...entries], { cwd: temporary });
    if (!entries.some(entry => fs.readFileSync(path.join(temporary, entry)).includes(Buffer.from(expected.serverUrl)))) throw new Error('Compiled bundle does not contain the selected server origin.');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
