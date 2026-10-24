import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createStartedHostedNativeEvidence,
  sha256File,
  writeHostedNativeEvidence
} from './hosted-native-evidence.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const APP_ID = 'net.darkmachines.healthtracker';
const ACTIVITY = `${APP_ID}/app.calibratehealth.wear.MainActivity`;
const UI_DUMP_PATH = '/sdcard/calibrate-wear-smoke.xml';
const REVIEWED_FONT_SCALES = Object.freeze([1, 1.3]);
const WEAR_UI_READY_ATTEMPTS = 15;
const WEAR_UI_POLL_SECONDS = '1';
const UNPAIRED_CONNECTION_ACCESSIBILITY_LABEL = 'Connection. Phone setup required';
const HOME_EXPECTED_TEXT = Object.freeze([
  'calibrate',
  "Pair with Calibrate on your phone to see today's summary.",
  UNPAIRED_CONNECTION_ACCESSIBILITY_LABEL
]);
// WorkManager and AndroidX receiver hardening contribute these entries to the merged release manifest.
const REVIEWED_WEAR_PERMISSIONS = Object.freeze([
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.INTERNET',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.WAKE_LOCK',
  'net.darkmachines.healthtracker.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
]);

export function parseBoundsRectangle(value) {
  const match = value.match(/^\[(\d+),(\d+)]\[(\d+),(\d+)]$/);
  if (!match) throw new Error(`Invalid Android bounds: ${value}`);
  const [, left, top, right, bottom] = match.map(Number);
  if (right <= left || bottom <= top) throw new Error('Android bounds must have positive area.');
  return { left, top, right, bottom };
}

export function parseBounds(value) {
  const { left, top, right, bottom } = parseBoundsRectangle(value);
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attribute(node, name) {
  const match = node.match(new RegExp(`${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : '';
}

export function parseWmSize(output) {
  const matches = [...output.matchAll(/(?:Physical|Override)?\s*size:\s*(\d+)x(\d+)/gi)];
  const match = matches.at(-1) ?? output.match(/^(\d+)x(\d+)$/m);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new Error('Unable to parse Wear screen size.');
  }
  return { width, height };
}

export function parseWmDensity(output) {
  const matches = [...output.matchAll(/(?:Physical|Override)?\s*density:\s*(\d+)/gi)];
  const match = matches.at(-1) ?? output.match(/^(\d+)$/m);
  const densityDpi = Number(match?.[1]);
  if (!Number.isSafeInteger(densityDpi) || densityDpi < 1) {
    throw new Error('Unable to parse Wear screen density.');
  }
  return densityDpi;
}

export function parseWearUiNodes(xml) {
  return (xml.match(/<node\b[^>]*>/g) ?? []).map((node) => ({
    text: attribute(node, 'text'),
    contentDescription: attribute(node, 'content-desc'),
    clickable: attribute(node, 'clickable') === 'true',
    enabled: attribute(node, 'enabled') !== 'false',
    packageName: attribute(node, 'package'),
    bounds: attribute(node, 'bounds')
  }));
}

export function auditWearActionTargets(xml, screen, densityDpi, options = {}) {
  const packageName = options.packageName ?? null;
  if (packageName !== null && (typeof packageName !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(packageName))) {
    throw new Error('Wear action audit requires an exact package name.');
  }
  const actions = parseWearUiNodes(xml).filter((node) => (
    node.clickable && node.enabled && (packageName === null || node.packageName === packageName)
  ));
  if (actions.length === 0 && options.requireAction !== false) {
    throw new Error('Wear UI must expose at least one enabled action.');
  }
  let minimumWidthDp = Number.POSITIVE_INFINITY;
  let minimumHeightDp = Number.POSITIVE_INFINITY;
  for (const [index, action] of actions.entries()) {
    if (!(action.text || action.contentDescription).trim()) {
      throw new Error(`Wear action ${index + 1} has no accessible name.`);
    }
    const bounds = parseBoundsRectangle(action.bounds);
    if (bounds.left < 0 || bounds.top < 0 || bounds.right > screen.width || bounds.bottom > screen.height) {
      throw new Error(`Wear action ${index + 1} is clipped outside the screen.`);
    }
    const widthDp = (bounds.right - bounds.left) * 160 / densityDpi;
    const heightDp = (bounds.bottom - bounds.top) * 160 / densityDpi;
    minimumWidthDp = Math.min(minimumWidthDp, widthDp);
    minimumHeightDp = Math.min(minimumHeightDp, heightDp);
    if (widthDp < 48 || heightDp < 48) {
      throw new Error(`Wear action ${index + 1} is smaller than 48 dp.`);
    }
  }
  return {
    actionCount: actions.length,
    minimumWidthDp: actions.length ? minimumWidthDp : null,
    minimumHeightDp: actions.length ? minimumHeightDp : null
  };
}

export function summarizeWearScale(fontScale, screen, densityDpi, audits) {
  const actionCount = audits.reduce((total, audit) => total + audit.actionCount, 0);
  const widths = audits.map((audit) => audit.minimumWidthDp).filter(Number.isFinite);
  const heights = audits.map((audit) => audit.minimumHeightDp).filter(Number.isFinite);
  if (actionCount < 1 || widths.length === 0 || heights.length === 0) {
    throw new Error('Wear scale audit did not inspect an enabled action.');
  }
  return {
    fontScale,
    screenWidthPx: screen.width,
    screenHeightPx: screen.height,
    densityDpi,
    actionCount,
    minimumWidthDp: Number(Math.min(...widths).toFixed(2)),
    minimumHeightDp: Number(Math.min(...heights).toFixed(2))
  };
}

export function findTextNode(xml, text) {
  const node = (xml.match(/<node\b[^>]*>/g) ?? [])
    .find((candidate) => (
      attribute(candidate, 'text') === text
      || attribute(candidate, 'content-desc') === text
    ));
  return node ? { text, bounds: attribute(node, 'bounds') } : null;
}
export function listWearUiPackages(xml) {
  return [...new Set(
    (xml.match(/<node\b[^>]*>/g) ?? [])
      .map((node) => attribute(node, 'package'))
      .filter((packageName) => /^[a-zA-Z0-9._-]+$/.test(packageName))
  )].sort();
}

/** Reassert the reviewed activity when Wear System UI takes foreground during first-boot settling. */
export function createRecoveringWearUiReader(expectedPackage, readUi, relaunch) {
  if (typeof expectedPackage !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(expectedPackage)) {
    throw new Error('Wear UI recovery requires an exact package name.');
  }
  return () => {
    const xml = readUi();
    if (!listWearUiPackages(xml).includes(expectedPackage)) relaunch();
    return xml;
  };
}

export function parseWearPackageVersion(output) {
  const versionCode = Number(output.match(/\bversionCode=(\d+)/)?.[1]);
  const versionName = output.match(/\bversionName=([^\r\n]+)/)?.[1]?.trim();
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || !versionName) {
    throw new Error('Unable to parse installed Wear package version.');
  }
  return { versionName, versionCode };
}

export function parseWearRequestedPermissions(output) {
  const lines = String(output).split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === 'requested permissions:');
  if (headerIndex < 0) throw new Error('Installed Wear requested-permissions section is missing.');
  const headerIndent = lines[headerIndex].match(/^\s*/)?.[0].length ?? 0;
  const permissions = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const value = line.trim();
    if (!value) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= headerIndent) break;
    permissions.push(value);
  }
  if (permissions.length === 0 || permissions.some((value) => !/^[A-Za-z0-9_.]+$/.test(value))) {
    throw new Error('Installed Wear requested permissions could not be parsed.');
  }
  return [...new Set(permissions)].sort();
}

export function assertWearRequestedPermissions(output) {
  const actual = parseWearRequestedPermissions(output);
  if (actual.length !== REVIEWED_WEAR_PERMISSIONS.length
      || actual.some((permission, index) => permission !== REVIEWED_WEAR_PERMISSIONS[index])) {
    throw new Error(
      `Installed Wear requested permissions differ from the reviewed allowlist: ${actual.join(', ')}.`
    );
  }
  return actual;
}

export function crashBufferContainsWearProcess(crashBuffer) {
  return [
    /Process:\s*net\.darkmachines\.healthtracker(?:[:,\s]|$)/i,
    /ANR in\s+net\.darkmachines\.healthtracker(?:[:,\s]|$)/i,
    /Cmdline:\s*net\.darkmachines\.healthtracker(?:[:,\s]|$)/i,
    />>>\s*net\.darkmachines\.healthtracker\s*<<</i
  ].some((pattern) => pattern.test(crashBuffer));
}
export function parseWearFontScale(output) {
  const normalized = String(output).trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    throw new Error('Unable to parse the Wear font scale.');
  }
  const fontScale = Number(normalized);
  if (!Number.isFinite(fontScale) || fontScale <= 0) {
    throw new Error('Unable to parse the Wear font scale.');
  }
  return fontScale;
}

export function setAndVerifyWearFontScale(fontScale, setFontScale, readFontScale) {
  const expected = parseWearFontScale(fontScale);
  setFontScale(String(fontScale));
  const actual = parseWearFontScale(readFontScale());
  if (actual !== expected) {
    throw new Error('Wear font scale readback ' + actual + ' did not match requested ' + expected + '.');
  }
  return actual;
}

export function restoreWearFontScale(originalFontScale, setFontScale, readFontScale) {
  if (originalFontScale === null) return false;
  setAndVerifyWearFontScale(originalFontScale, setFontScale, readFontScale);
  return true;
}

/** Wait for one complete reviewed surface; transient splash/partial trees never count as evidence. */
export function waitForWearUi(expectedText, readUi, waitBetweenAttempts, maxAttempts = WEAR_UI_READY_ATTEMPTS) {
  if (!Array.isArray(expectedText) || expectedText.length === 0
      || expectedText.some((text) => typeof text !== 'string' || !text)) {
    throw new Error('Wear UI readiness requires exact non-empty text selectors.');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Wear UI readiness attempts must be a positive integer.');
  }
  let missing = [...expectedText];
  let lastXml = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastXml = readUi();
    missing = expectedText.filter((text) => !findTextNode(lastXml, text));
    if (missing.length === 0) return lastXml;
    if (attempt < maxAttempts) waitBetweenAttempts();
  }
  const packages = listWearUiPackages(lastXml);
  throw new Error(
    `Wear UI did not become ready with expected text: ${missing.join(' | ')}; visible packages: ${packages.join(', ') || 'none'}`
  );
}

/** Verify one scrollable Wear surface without requiring off-screen rows in one UI dump. */
export function waitForScrollableWearUi(expectedText, readUi, scrollForward, maxAttempts = WEAR_UI_READY_ATTEMPTS) {
  if (!Array.isArray(expectedText) || expectedText.length === 0
      || expectedText.some((text) => typeof text !== 'string' || !text)) {
    throw new Error('Scrollable Wear UI readiness requires exact non-empty text selectors.');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('Scrollable Wear UI readiness attempts must be a positive integer.');
  }
  const missing = new Set(expectedText);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const xml = readUi();
    for (const text of missing) {
      if (findTextNode(xml, text)) missing.delete(text);
    }
    if (missing.size === 0) return xml;
    if (attempt < maxAttempts) scrollForward();
  }
  throw new Error(`Scrollable Wear UI did not expose expected text: ${[...missing].join(' | ')}`);
}

export function resolveWearAdb(environment = process.env, platform = process.platform) {
  if (environment.ADB?.trim()) return environment.ADB.trim();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const sdkRoot = environment.ANDROID_HOME
    ?? environment.ANDROID_SDK_ROOT
    ?? (environment.LOCALAPPDATA ? pathApi.join(environment.LOCALAPPDATA, 'Android', 'Sdk') : null);
  if (!sdkRoot) return platform === 'win32' ? 'adb.exe' : 'adb';
  return pathApi.join(sdkRoot, 'platform-tools', platform === 'win32' ? 'adb.exe' : 'adb');
}

export function prepareWearUi(run) {
  for (const args of [
    ['shell', 'settings', 'put', 'global', 'device_provisioned', '1'],
    ['shell', 'settings', 'put', 'secure', 'user_setup_complete', '1']
  ]) run(args);
  for (const [namespace, key] of [
    ['global', 'device_provisioned'],
    ['secure', 'user_setup_complete']
  ]) {
    const value = String(run(['shell', 'settings', 'get', namespace, key])).trim();
    if (value !== '1') {
      throw new Error(`Wear emulator setup did not persist ${namespace} ${key}=1.`);
    }
  }
  return [
    ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'],
    ['shell', 'wm', 'dismiss-keyguard'],
    ['shell', 'input', 'keyevent', '82']
  ].map((args) => run(args));
}

function runAdb(adb, serial, args, options = {}) {
  return execFileSync(adb, ['-s', serial, ...args], {
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit']
  }).trim();
}

function dumpUi(adb, serial) {
  runAdb(adb, serial, ['shell', 'uiautomator', 'dump', UI_DUMP_PATH], { quiet: true });
  return runAdb(adb, serial, ['exec-out', 'cat', UI_DUMP_PATH], { quiet: true });
}

function requireText(xml, text) {
  const node = findTextNode(xml, text);
  if (!node) throw new Error(`Wear UI did not expose expected text: ${text}`);
  return node;
}

function launchWear(adb, serial) {
  runAdb(adb, serial, ['shell', 'am', 'force-stop', APP_ID], { quiet: true });
  const launch = runAdb(adb, serial, ['shell', 'am', 'start', '-W', '-n', ACTIVITY], { quiet: true });
  if (!launch.includes('Status: ok')) throw new Error(`Wear activity failed to launch:\n${launch}`);
  return launch;
}

function exerciseWearScale({ adb, serial, expectedBuildType, screen, densityDpi, fontScale }) {
  setAndVerifyWearFontScale(
    fontScale,
    (value) => runAdb(adb, serial, ['shell', 'settings', 'put', 'system', 'font_scale', value], { quiet: true }),
    () => runAdb(adb, serial, ['shell', 'settings', 'get', 'system', 'font_scale'], { quiet: true })
  );
  let launch = launchWear(adb, serial);
  const readHomeUi = createRecoveringWearUiReader(
    APP_ID,
    () => dumpUi(adb, serial),
    () => { launch = launchWear(adb, serial); }
  );
  const waitForExpectedUi = (expectedText) => waitForWearUi(
    expectedText,
    readHomeUi,
    () => runAdb(adb, serial, ['shell', 'sleep', WEAR_UI_POLL_SECONDS], { quiet: true })
  );
  const home = waitForExpectedUi(HOME_EXPECTED_TEXT);
  const connection = requireText(home, UNPAIRED_CONNECTION_ACCESSIBILITY_LABEL);
  const homeAudit = auditWearActionTargets(home, screen, densityDpi, { packageName: APP_ID });
  const point = parseBounds(connection.bounds);
  runAdb(adb, serial, ['shell', 'input', 'tap', String(point.x), String(point.y)], { quiet: true });
  waitForExpectedUi(['Connection', 'Server']);

  const detail = waitForScrollableWearUi([
    'Connection',
    `${expectedBuildType} build`,
    'Open Calibrate settings on your phone and choose the nearby watch to begin.'
  ], () => dumpUi(adb, serial), () => {
    const centerX = String(Math.round(screen.width / 2));
    runAdb(adb, serial, [
      'shell', 'input', 'swipe', centerX,
      String(Math.round(screen.height * 0.78)), centerX,
      String(Math.round(screen.height * 0.22)), '300'
    ], { quiet: true });
    runAdb(adb, serial, ['shell', 'sleep', WEAR_UI_POLL_SECONDS], { quiet: true });
  });
  const detailAudit = auditWearActionTargets(detail, screen, densityDpi, {
    packageName: APP_ID,
    requireAction: false
  });
  return {
    launch,
    summary: summarizeWearScale(fontScale, screen, densityDpi, [homeAudit, detailAudit])
  };
}

function stageEvidence(evidenceFile, evidence, stage) {
  if (!evidenceFile) return evidence;
  const next = { ...evidence, stage };
  writeHostedNativeEvidence(evidenceFile, next);
  return next;
}

/** Exercise a non-debuggable watch shell and privacy-sensitive package state on an adb Wear target. */
export function runWearEmulatorSmoke(environment = process.env) {
  const adb = resolveWearAdb(environment);
  const serial = environment.WEAR_ADB_SERIAL ?? 'emulator-5556';
  const expectedBuildType = environment.WEAR_BUILD_TYPE ?? 'release';
  const apk = path.resolve(
    repositoryRoot,
    environment.WEAR_APK ?? 'wear/app/build/outputs/apk/release/app-release.apk'
  );
  const evidenceFile = environment.CALIBRATE_HOSTED_EVIDENCE_OUTPUT?.trim() || null;
  let hostedEvidence = evidenceFile
    ? createStartedHostedNativeEvidence('wear', environment.CALIBRATE_SOURCE_COMMIT?.trim())
    : null;
  if (evidenceFile) writeHostedNativeEvidence(evidenceFile, hostedEvidence);
  let activeStage = 'initialized';
  let originalFontScale = null;
  let completed = null;
  let failure = null;

  try {
    if (!fs.existsSync(apk)) throw new Error('Wear APK is missing. Build the release artifact first.');
    activeStage = 'emulator';
    hostedEvidence = stageEvidence(evidenceFile, hostedEvidence, activeStage);
    const characteristics = runAdb(adb, serial, ['shell', 'getprop', 'ro.build.characteristics'], { quiet: true });
    if (!characteristics.split(',').includes('watch')) throw new Error('Configured target is not Wear OS.');
    const [model, api, abi, sizeOutput, densityOutput, fontScaleOutput] = [
      ['shell', 'getprop', 'ro.product.model'],
      ['shell', 'getprop', 'ro.build.version.sdk'],
      ['shell', 'getprop', 'ro.product.cpu.abi'],
      ['shell', 'wm', 'size'],
      ['shell', 'wm', 'density'],
      ['shell', 'settings', 'get', 'system', 'font_scale']
    ].map((args) => runAdb(adb, serial, args, { quiet: true }));
    const emulator = {
      role: 'wear',
      apiLevel: Number(api),
      model,
      abi,
      physical: false
    };
    const screen = parseWmSize(sizeOutput);
    const densityDpi = parseWmDensity(densityOutput);
    const parsedOriginalScale = parseWearFontScale(fontScaleOutput);
    originalFontScale = String(parsedOriginalScale);
    if (hostedEvidence) {
      hostedEvidence.emulators = [emulator];
      hostedEvidence.checkpoints.emulatorValidated = true;
      writeHostedNativeEvidence(evidenceFile, hostedEvidence);
    }

    activeStage = 'install';
    hostedEvidence = stageEvidence(evidenceFile, hostedEvidence, activeStage);
    runAdb(adb, serial, ['install', '-r', apk]);
    prepareWearUi((args) => runAdb(adb, serial, args, { quiet: true }));
    runAdb(adb, serial, ['logcat', '-c'], { quiet: true });

    const scaleSummaries = [];
    for (const fontScale of REVIEWED_FONT_SCALES) {
      activeStage = fontScale === 1 ? 'default-scale' : 'large-text-scale';
      hostedEvidence = stageEvidence(evidenceFile, hostedEvidence, activeStage);
      const result = exerciseWearScale({ adb, serial, expectedBuildType, screen, densityDpi, fontScale });
      scaleSummaries.push(result.summary);
      if (hostedEvidence) {
        hostedEvidence.checkpoints.unpairedShell = true;
        hostedEvidence.checkpoints.connectionDetail = true;
        hostedEvidence.checkpoints.touchTargets = true;
        hostedEvidence.checkpoints.namedActions = true;
        hostedEvidence.checkpoints.withinScreen = true;
        hostedEvidence.checkpoints[fontScale === 1 ? 'defaultScale' : 'largeTextScale'] = true;
      }
      completed = { ...(completed ?? {}), launch: result.launch };
    }

    activeStage = 'package-contract';
    hostedEvidence = stageEvidence(evidenceFile, hostedEvidence, activeStage);
    const packageState = runAdb(adb, serial, ['shell', 'dumpsys', 'package', APP_ID], { quiet: true });
    if (packageState.includes('DEBUGGABLE')) throw new Error('Installed Wear release package is debuggable.');
    if (!packageState.includes('app.calibratehealth.wear.tile.CalibrateTileService')) {
      throw new Error('Wear Tile provider is missing from the installed package.');
    }
    if (!/android\.permission\.POST_NOTIFICATIONS: granted=false/.test(packageState)) {
      throw new Error('Wear requested notification permission before an explicit user action.');
    }
    assertWearRequestedPermissions(packageState);
    const crashes = runAdb(adb, serial, ['logcat', '-b', 'crash', '-d', '-v', 'brief'], { quiet: true });
    if (crashBufferContainsWearProcess(crashes)) {
      throw new Error('Wear crash buffer is not empty.');
    }
    const version = parseWearPackageVersion(packageState);
    completed = { ...completed, emulator, scaleSummaries, version };
    if (hostedEvidence) {
      hostedEvidence.artifacts = [{
        id: 'wear-release',
        packageName: APP_ID,
        ...version,
        sha256: sha256File(apk),
        buildType: expectedBuildType,
        disposableSigning: environment.CALIBRATE_DISPOSABLE_SIGNING === 'true'
      }];
      hostedEvidence.checkpoints.nonDebuggable = true;
      hostedEvidence.checkpoints.tilePresent = true;
      hostedEvidence.checkpoints.permissionsMinimal = true;
      hostedEvidence.checkpoints.crashClean = true;
      hostedEvidence.wearAccessibility = { fontScales: scaleSummaries };
    }
  } catch (error) {
    failure = error;
  } finally {
    if (originalFontScale !== null) {
      try {
        restoreWearFontScale(originalFontScale, (value) => {
          runAdb(adb, serial, ['shell', 'settings', 'put', 'system', 'font_scale', value], { quiet: true });
        }, () => runAdb(
          adb,
          serial,
          ['shell', 'settings', 'get', 'system', 'font_scale'],
          { quiet: true }
        ));
        if (hostedEvidence) hostedEvidence.checkpoints.fontScaleRestored = true;
      } catch (restoreError) {
        failure ??= restoreError;
      }
    }
    if (hostedEvidence) {
      hostedEvidence.status = failure ? 'failed' : 'passed';
      hostedEvidence.stage = failure ? activeStage : 'completed';
      writeHostedNativeEvidence(evidenceFile, hostedEvidence);
    }
  }

  if (failure) throw failure;
  const totalTime = completed.launch.match(/TotalTime:\s*(\d+)/)?.[1] ?? 'unknown';
  console.log(
    `PASS Wear ${expectedBuildType} smoke: cold start ${totalTime} ms, two font scales, ` +
    '48 dp named actions, unpaired/connection UI, Tile, permissions, and crash buffer.'
  );
  return completed;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runWearEmulatorSmoke();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
