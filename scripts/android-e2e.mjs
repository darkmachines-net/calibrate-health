import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createStartedHostedNativeEvidence,
  sha256File,
  writeHostedNativeEvidence
} from './hosted-native-evidence.mjs';

const API_URL = process.env.CALIBRATE_E2E_API_URL ?? 'http://127.0.0.1:3000';
const TEST_EMAIL = process.env.CALIBRATE_E2E_EMAIL ?? 'test@calibratehealth.app';
const TEST_PASSWORD = process.env.CALIBRATE_E2E_PASSWORD ?? 'password123';
const APP_ID = 'net.darkmachines.healthtracker';
export const ANDROID_E2E_METRO_STATUS_URL = 'http://localhost:8081/status';
export const ANDROID_E2E_INITIAL_LAUNCH_TIMEOUT_MS = 150_000;
const ONLINE_FOOD = { name: 'Android E2E latte', calories: 190 };
const OFFLINE_FOOD = { name: 'Android E2E protein shake', calories: 240 };
const UI_DUMP_PATH = '/sdcard/calibrate-e2e-window.xml';

export function buildAddFoodDeepLink(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Android E2E Add food date must be YYYY-MM-DD.');
  return `https://calibratehealth.app/log?date=${encodeURIComponent(date)}`;
}
export function buildAddFoodLaunchArgs(date) {
  return [
    'shell', 'am', 'start', '-W', '-S',
    '-a', 'android.intent.action.VIEW',
    '-d', buildAddFoodDeepLink(date),
    APP_ID,
  ];
}

export function assertAndroidAppLinkLaunch(output) {
  if (!/\bStatus:\s*ok\b/i.test(output) || !/\bActivity:\s*net\.darkmachines\.healthtracker\//i.test(output)) {
    throw new Error('Android E2E app link did not launch the Calibrate activity.');
  }
}

const METRO_REVERSE_HOST = 'localhost:8081';
const API_REVERSE_PORT = 'tcp:3000';
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'content-encoding', 'content-length', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);
export function resolveAndroidE2eAdb(environment = process.env, platform = process.platform) {
  if (environment.ADB?.trim()) return environment.ADB.trim();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const sdkRoot = environment.ANDROID_HOME
    ?? environment.ANDROID_SDK_ROOT
    ?? (environment.LOCALAPPDATA ? pathApi.join(environment.LOCALAPPDATA, 'Android', 'Sdk') : null);
  if (!sdkRoot) return platform === 'win32' ? 'adb.exe' : 'adb';
  return pathApi.join(sdkRoot, 'platform-tools', platform === 'win32' ? 'adb.exe' : 'adb');
}

export function buildAndroidE2eAdbArgs(args, serial = process.env.ANDROID_ADB_SERIAL) {
  const target = serial?.trim();
  if (!target || !/^emulator-\d+$/.test(target)) {
    throw new Error('ANDROID_ADB_SERIAL must explicitly name an emulator-<port> target.');
  }
  return ['-s', target, ...args];
}

const ADB = resolveAndroidE2eAdb();
const release = JSON.parse(readFileSync(new URL('../shared/release.json', import.meta.url), 'utf8'));
const NATIVE_CLIENT_HEADERS = {
  PLATFORM: 'x-calibrate-client-platform',
  VERSION: 'x-calibrate-client-version'
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function adb(args, options = {}) {
  return execFileSync(ADB, buildAndroidE2eAdbArgs(args), {
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit']
  }).trim();
}

export async function fetchAndroidE2eProxyUpstream(url, options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleepImpl = dependencies.sleepImpl ?? sleep;
  const attempts = options.method === 'GET' ? 3 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchImpl(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleepImpl(250 * attempt);
    }
  }
  throw lastError;
}

/** Proxy the app's reversed loopback API separately from the host-side assertions. */
async function startApiProxy() {
  const target = new URL(API_URL);
  let available = true;
  let closed = false;
  const server = http.createServer(async (request, response) => {
    if (!available) {
      request.resume();
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"message":"Android E2E API proxy is offline."}');
      return;
    }

    try {
      const bodyChunks = [];
      for await (const chunk of request) bodyChunks.push(chunk);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && name !== 'host' && !HOP_BY_HOP_HEADERS.has(name)) {
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
      }
      const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;
      const upstream = await fetchAndroidE2eProxyUpstream(new URL(request.url ?? '/', target), {
        method: request.method,
        headers,
        body
      });
      const responseHeaders = {};
      upstream.headers.forEach((value, name) => {
        if (!HOP_BY_HOP_HEADERS.has(name)) responseHeaders[name] = value;
      });
      response.writeHead(upstream.status, responseHeaders);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      if (closed) {
        response.destroy();
        return;
      }
      console.error(`Android E2E API proxy failed ${request.method} ${request.url}: ${error.message}`);
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to start the Android E2E API proxy.');

  return {
    port: address.port,
    setAvailable: (nextAvailable) => {
      available = nextAvailable;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function reverseApiTo(proxy) {
  adb(['reverse', API_REVERSE_PORT, `tcp:${proxy.port}`], { quiet: true });
}

function removeApiReverse() {
  try {
    adb(['reverse', '--remove', API_REVERSE_PORT], { quiet: true });
  } catch {
    // A failed run may already have removed the isolated API mapping.
  }
}

async function waitFor(label, check, timeoutMs = 30_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}.${lastError ? ` Last error: ${lastError.message}` : ''}`);
}

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function readAttribute(node, name) {
  const match = node.match(new RegExp(`${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : '';
}

function parseBounds(value) {
  const match = value.match(/^\[(\d+),(\d+)]\[(\d+),(\d+)]$/);
  if (!match) throw new Error(`Invalid Android bounds: ${value}`);
  const [, left, top, right, bottom] = match.map(Number);
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

function dumpUi() {
  adb(['shell', 'uiautomator', 'dump', UI_DUMP_PATH], { quiet: true });
  return adb(['exec-out', 'cat', UI_DUMP_PATH], { quiet: true });
}

/** Keep Metro on adb reverse while the API proxy is isolated independently. */
function configureMetroReverseHost() {
  const preferencesFile = `shared_prefs/${APP_ID}_preferences.xml`;
  const preferences = `<map><string name="debug_http_host">${METRO_REVERSE_HOST}</string></map>`;
  const encodedPreferences = Buffer.from(preferences, 'utf8').toString('base64');
  const writePreferences =
    `mkdir -p shared_prefs && echo ${encodedPreferences} | base64 -d > ${preferencesFile}`;
  adb(['reverse', 'tcp:8081', 'tcp:8081'], { quiet: true });
  adb(['shell', `run-as ${APP_ID} sh -c '${writePreferences}'`], { quiet: true });
}

function findNode(xml, predicate) {
  const nodes = xml.match(/<node\b[^>]*>/g) ?? [];
  for (const node of nodes) {
    const candidate = {
      text: readAttribute(node, 'text'),
      label: readAttribute(node, 'content-desc'),
      bounds: readAttribute(node, 'bounds'),
      clickable: readAttribute(node, 'clickable') === 'true'
    };
    if (predicate(candidate)) return candidate;
  }
  return null;
}

async function waitForNode(label, predicate, timeoutMs = 30_000) {
  return waitFor(label, async () => findNode(dumpUi(), predicate), timeoutMs, 750);
}

function tapFoundNode(node) {
  const point = parseBounds(node.bounds);
  adb(['shell', 'input', 'tap', String(point.x), String(point.y)], { quiet: true });
}

async function tapNode(label, predicate, timeoutMs = 30_000) {
  tapFoundNode(await waitForNode(label, predicate, timeoutMs));
}


/** Attach the release-candidate phone identity to direct API assertions made outside the app. */
export function buildE2eRequestHeaders(initialHeaders = {}) {
  const headers = new Headers(initialHeaders);
  headers.set(NATIVE_CLIENT_HEADERS.PLATFORM, 'android_phone');
  headers.set(NATIVE_CLIENT_HEADERS.VERSION, release.android.mobile.version_name);
  return headers;
}

/** Ignore shell/test-runner crashes while still failing on Java, ANR, or native Calibrate crashes. */
export function crashBufferContainsCalibrateProcess(crashBuffer) {
  return [
    /Process:\s*net\.darkmachines\.healthtracker(?:[:,\s]|$)/i,
    /ANR in\s+net\.darkmachines\.healthtracker(?:[:,\s]|$)/i,
    /Cmdline:\s*net\.darkmachines\.healthtracker(?:[:,\s]|$)/i,
    />>>\s*net\.darkmachines\.healthtracker\s*<<</i
  ].some((pattern) => pattern.test(crashBuffer));
}

export function parseAndroidPackageVersion(output) {
  const versionCode = Number(output.match(/\bversionCode=(\d+)/)?.[1]);
  const versionName = output.match(/\bversionName=([^\r\n]+)/)?.[1]?.trim();
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || !versionName) {
    throw new Error('Unable to parse installed Android package version.');
  }
  return { versionName, versionCode };
}

async function requestJson(pathname, options = {}) {
  const method = options.method ?? 'GET';
  const attempts = method === 'GET' ? 3 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${API_URL}${pathname}`, {
        ...options,
        headers: buildE2eRequestHeaders(options.headers)
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${method} ${pathname} returned ${response.status}`);
      return body;
    } catch (error) {
      lastError = error;
      // The local dev server may retire an idle keep-alive socket while the emulator boots.
      if (attempt < attempts) await sleep(250 * attempt);
    }
  }
  throw lastError;
}

const SAFE_ANDROID_UI_MARKERS = Object.freeze([
  'Opening add food...', 'Add food', 'Add & close', 'Quick', 'Today', 'Restoring session...',
  'Food logging is unavailable', 'Sign in',
]);

export function summarizeAndroidE2eUi(xml) {
  const nodes = xml.match(/<node\b[^>]*>/g) ?? [];
  const markers = SAFE_ANDROID_UI_MARKERS.filter((marker) => nodes.some((node) => (
    readAttribute(node, 'text') === marker || readAttribute(node, 'content-desc') === marker
  )));
  return markers.length > 0 ? markers.join(', ') : 'none';
}

export function isAndroidE2eRecentFoodNode(node, name) {
  return node?.clickable === true && node?.label === `Choose amount for ${name}`;
}

export function isAndroidE2eAddAndCloseNode(node) {
  return node?.clickable === true && node?.label === 'Add & close';
}

async function loginApi() {
  return requestJson('/auth/mobile/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      device_id: 'android-e2e-probe',
      device_platform: 'android_phone',
      device_name: 'Android E2E probe'
    })
  });
}

function localDateFor(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

async function countFood(accessToken, date, name) {
  const logs = await requestJson(`/api/v1/food?date=${encodeURIComponent(date)}`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  return logs.filter((entry) => entry.name === name).length;
}

export function buildOpenFoodDayRequest(accessToken, date, operationId = randomUUID()) {
  return {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'x-client-operation-id': operationId
    },
    body: JSON.stringify({ date, status: 'OPEN' })
  };
}

/** Reopen the deterministic seed's current day before adding E2E-only recent foods. */
async function ensureFoodDayOpen(accessToken, date) {
  await requestJson('/api/v1/food-days', buildOpenFoodDayRequest(accessToken, date));
}

/** Put known rows at the front of Add Food recents without relying on mutable seed history. */
async function seedRecentFood(accessToken, date, food) {
  await requestJson('/api/v1/food', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      meal_period: 'DINNER',
      name: food.name,
      calories: food.calories,
      date
    })
  });
}

async function waitForFoodCount(accessToken, date, name, expected, timeoutMs = 30_000) {
  return waitFor(`${name} count ${expected}`, async () => {
    const count = await countFood(accessToken, date, name);
    return count === expected ? count : null;
  }, timeoutMs, 750);
}

async function openRecentAdd(name, date, timeoutMs = 45_000) {
  const launchOutput = adb(buildAddFoodLaunchArgs(date), { quiet: true });
  assertAndroidAppLinkLaunch(launchOutput);
  try {
    await waitForNode(
      `${name} recent row`,
      (node) => isAndroidE2eRecentFoodNode(node, name),
      timeoutMs,
    );
  } catch (error) {
    let markers = 'unavailable';
    try {
      markers = summarizeAndroidE2eUi(dumpUi());
    } catch {
      // Keep failure diagnostics bounded if UI automation itself is unavailable.
    }
    throw new Error(`${error.message} Safe UI markers: ${markers}.`, { cause: error });
  }
}

async function logOpenRecentFood(name, waitForSheetClose = true) {
  await tapNode(`${name} recent row`, (node) => isAndroidE2eRecentFoodNode(node, name));
  await tapNode('Add & close', isAndroidE2eAddAndCloseNode);
  if (waitForSheetClose) {
    await waitForNode('Add food sheet to close', (node) => node.clickable && node.label === 'Add food', 45_000);
  }
}

async function logRecentFood(name, date, timeoutMs = 45_000) {
  await openRecentAdd(name, date, timeoutMs);
  await logOpenRecentFood(name, false);
}

async function runAndroidE2e(onCheckpoint = () => undefined) {
  let apiProxy;
  adb(['wait-for-device'], { quiet: true });
  const qemu = adb(['shell', 'getprop', 'ro.kernel.qemu'], { quiet: true });
  const characteristics = adb(['shell', 'getprop', 'ro.build.characteristics'], { quiet: true });
  if (qemu !== '1' || characteristics.split(',').includes('watch')) {
    throw new Error('ANDROID_ADB_SERIAL must resolve to an Android phone emulator.');
  }
  const emulator = {
    role: 'phone',
    apiLevel: Number(adb(['shell', 'getprop', 'ro.build.version.sdk'], { quiet: true })),
    model: adb(['shell', 'getprop', 'ro.product.model'], { quiet: true }),
    abi: adb(['shell', 'getprop', 'ro.product.cpu.abi'], { quiet: true }),
    physical: false
  };
  onCheckpoint('emulatorValidated', { emulator });
  const health = await requestJson('/api/v1/healthz');
  if (!health.ok) throw new Error('Calibrate E2E backend health check failed.');
  onCheckpoint('backendReady');
  const metroStatus = await fetch(ANDROID_E2E_METRO_STATUS_URL).then((response) => response.text());
  if (!metroStatus.includes('packager-status:running')) {
    throw new Error('Metro is not running on port 8081. Start the mobile dev server first.');
  }
  onCheckpoint('metroReady');

  const session = await loginApi();
  const date = localDateFor(session.user.timezone);
  await ensureFoodDayOpen(session.access_token, date);
  await seedRecentFood(session.access_token, date, ONLINE_FOOD);
  await seedRecentFood(session.access_token, date, OFFLINE_FOOD);
  apiProxy = await startApiProxy();
  adb(['shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'], { quiet: true });
  reverseApiTo(apiProxy);
  // Scope the crash assertion to this run so stale emulator crashes do not cause a false failure.
  adb(['logcat', '-c'], { quiet: true });
  adb(['shell', 'pm', 'clear', APP_ID], { quiet: true });
  configureMetroReverseHost();

  try {
    const onlineName = ONLINE_FOOD.name;
    const onlineBefore = await countFood(session.access_token, date, onlineName);
    // The canonical app link owns the first launch and triggers Metro's cold Android bundle.
    await logRecentFood(onlineName, date, ANDROID_E2E_INITIAL_LAUNCH_TIMEOUT_MS);
    await waitForFoodCount(session.access_token, date, onlineName, onlineBefore + 1);
    onCheckpoint('onlineLog');
    console.log(`PASS online one-tap logging count: ${onlineBefore} -> ${onlineBefore + 1}`);

    const offlineName = OFFLINE_FOOD.name;
    const offlineBefore = await countFood(session.access_token, date, offlineName);
    // Load the cached recent list before isolating the API while Metro remains reachable through adb reverse.
    await openRecentAdd(offlineName, date);
    apiProxy.setAvailable(false);
    await logOpenRecentFood(offlineName);
    const pendingBadge = await waitForNode(
      'offline pending badge',
      (node) => node.clickable && node.label.includes('offline changes pending'),
      25_000
    );
    if (!pendingBadge) throw new Error('Queued write was not exposed in the account accessibility label.');
    if (await countFood(session.access_token, date, offlineName) !== offlineBefore) {
      throw new Error('Offline write reached the server before reconnect.');
    }
    onCheckpoint('offlineQueue');

    adb(['shell', 'am', 'force-stop', APP_ID], { quiet: true });
    apiProxy.setAvailable(true);
    await openRecentAdd(offlineName, date);
    await waitForFoodCount(session.access_token, date, offlineName, offlineBefore + 1, 45_000);
    onCheckpoint('processDeathReplay');
    console.log(`PASS process-death replay count: ${offlineBefore} -> ${offlineBefore + 1}`);

    await openRecentAdd(offlineName, date);
    await sleep(3_000);
    const finalCount = await countFood(session.access_token, date, offlineName);
    if (finalCount !== offlineBefore + 1) {
      throw new Error(`Replay duplicated ${offlineName}: expected ${offlineBefore + 1}, received ${finalCount}`);
    }
    const finalPid = adb(['shell', 'pidof', '-s', APP_ID], { quiet: true });
    if (!finalPid) throw new Error('Calibrate process is not alive after the final replay check.');
    onCheckpoint('processAlive');
    const crashes = adb(['logcat', '-b', 'crash', '-d', '-v', 'brief'], { quiet: true });
    if (crashBufferContainsCalibrateProcess(crashes)) {
      throw new Error(`Calibrate appears in the Android crash buffer:\n${crashes}`);
    }
    onCheckpoint('crashClean');
    onCheckpoint('exactlyOnceReplay');
    console.log(`PASS exactly-once replay after second restart: count remained ${finalCount}`);
  } finally {
    adb(['shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'], { quiet: true });
    await apiProxy?.close().catch(() => undefined);
    removeApiReverse();
  }
  return { emulator };
}

const ANDROID_CHECKPOINT_STAGES = Object.freeze({
  emulatorValidated: 'emulator',
  backendReady: 'backend',
  metroReady: 'metro',
  onlineLog: 'online-log',
  offlineQueue: 'offline-queue',
  processDeathReplay: 'process-death-replay',
  processAlive: 'exactly-once',
  crashClean: 'exactly-once',
  exactlyOnceReplay: 'exactly-once'
});

async function main() {
  const evidenceFile = process.env.CALIBRATE_HOSTED_EVIDENCE_OUTPUT?.trim() || null;
  let evidence = evidenceFile
    ? createStartedHostedNativeEvidence('android', process.env.CALIBRATE_SOURCE_COMMIT?.trim())
    : null;
  if (evidenceFile) writeHostedNativeEvidence(evidenceFile, evidence);
  const onCheckpoint = (checkpoint, details = {}) => {
    if (!evidence) return;
    evidence.checkpoints[checkpoint] = true;
    evidence.stage = ANDROID_CHECKPOINT_STAGES[checkpoint];
    if (details.emulator) evidence.emulators = [details.emulator];
    writeHostedNativeEvidence(evidenceFile, evidence);
  };
  try {
    await runAndroidE2e(onCheckpoint);
    if (evidence) {
      const apk = path.resolve(process.env.CALIBRATE_ANDROID_APK ?? '.ci-artifacts/android-debug/app-debug.apk');
      const packageState = adb(['shell', 'dumpsys', 'package', APP_ID], { quiet: true });
      evidence.artifacts = [{
        id: 'android-debug',
        packageName: APP_ID,
        ...parseAndroidPackageVersion(packageState),
        sha256: sha256File(apk),
        buildType: 'debug',
        disposableSigning: process.env.CALIBRATE_DISPOSABLE_SIGNING === 'true'
      }];
      evidence.status = 'passed';
      evidence.stage = 'completed';
      writeHostedNativeEvidence(evidenceFile, evidence);
    }
  } catch (error) {
    if (evidence) {
      evidence.status = 'failed';
      writeHostedNativeEvidence(evidenceFile, evidence);
    }
    throw error;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
