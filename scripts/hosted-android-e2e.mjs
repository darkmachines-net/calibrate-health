#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildAndroidE2eAdbArgs, resolveAndroidE2eAdb } from './android-e2e.mjs';

const HOSTED_ANDROID_METRO_TIMEOUT_MS = 90_000;
export const HOSTED_ANDROID_LOG_MAX_BYTES = 256 * 1024;
const HOSTED_ANDROID_DIAGNOSTIC_LINES = 80;
const METRO_STATUS_URL = 'http://localhost:8081/status';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function assertHostedAndroidRunner(environment = process.env, platform = process.platform) {
  if (environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_OS !== 'Linux' || platform !== 'linux') {
    throw new Error('Hosted Android E2E is restricted to GitHub Actions Linux runners.');
  }
  if (!environment.RUNNER_TEMP?.trim()) throw new Error('RUNNER_TEMP is required.');
  if (!environment.ANDROID_HOME?.trim() && !environment.ANDROID_SDK_ROOT?.trim() && !environment.ADB?.trim()) {
    throw new Error('ANDROID_HOME, ANDROID_SDK_ROOT, or ADB is required.');
  }
  buildAndroidE2eAdbArgs([], environment.ANDROID_ADB_SERIAL);
}

export function createHostedAndroidCommandPlan(
  environment = process.env,
  platform = process.platform,
  root = repositoryRoot
) {
  assertHostedAndroidRunner(environment, platform);
  const serial = environment.ANDROID_ADB_SERIAL.trim();
  const apk = path.resolve(root, environment.CALIBRATE_ANDROID_APK?.trim()
    || '.ci-artifacts/android-debug/app-debug.apk');
  const logFile = path.join(path.resolve(environment.RUNNER_TEMP.trim()), 'calibrate-native', 'metro.log');
  const adb = resolveAndroidE2eAdb(environment, platform);
  return {
    config: { apk, logFile, serial },
    metro: {
      command: 'npm',
      args: ['--prefix', 'mobile', 'run', 'dev', '--', '--host', 'localhost', '--port', '8081'],
      cwd: root
    },
    install: {
      command: adb,
      args: buildAndroidE2eAdbArgs(['install', '-r', apk], serial),
      cwd: root
    },
    e2e: {
      command: 'npm',
      args: ['run', 'test:android:e2e'],
      cwd: root
    }
  };
}

export function createHostedAndroidMetroEnvironment(environment = process.env) {
  return { ...environment, CI: '1' };
}

/** Remove credentials and control sequences before retaining or printing hosted diagnostics. */
export function redactHostedAndroidDiagnostics(value) {
  return String(value)
    // eslint-disable-next-line no-control-regex -- Strip terminal escape sequences from retained diagnostics.
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replaceAll(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replaceAll(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replaceAll(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))=([^\s]+)/gi, '$1=[redacted]');
}

export function boundHostedAndroidLog(value, maxBytes = HOSTED_ANDROID_LOG_MAX_BYTES) {
  const sanitized = Buffer.from(redactHostedAndroidDiagnostics(value), 'utf8');
  if (sanitized.byteLength <= maxBytes) return sanitized.toString('utf8');
  let start = sanitized.byteLength - maxBytes;
  while ((sanitized[start] & 0xc0) === 0x80) start += 1;
  return sanitized.subarray(start).toString('utf8');
}

function createHostedAndroidLog(logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, '', { encoding: 'utf8', mode: 0o600 });
  let retained = '';
  return {
    write(chunk) {
      retained = boundHostedAndroidLog(retained + chunk);
      fs.writeFileSync(logFile, retained, { encoding: 'utf8', mode: 0o600 });
    },
    diagnostics() {
      return retained.split(/\r?\n/).slice(-HOSTED_ANDROID_DIAGNOSTIC_LINES).join('\n');
    }
  };
}

function startMetro(request, environment, log) {
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    detached: true,
    env: createHostedAndroidMetroEnvironment(environment),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => log.write(chunk));
  child.stderr.on('data', (chunk) => log.write(chunk));
  return child;
}

function metroExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function waitForHostedAndroidMetro(child, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleepImpl = options.sleepImpl ?? sleep;
  const abortSignalTimeout = options.abortSignalTimeout ?? AbortSignal.timeout.bind(AbortSignal);
  const timeoutMs = options.timeoutMs ?? HOSTED_ANDROID_METRO_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  let spawnError = null;
  child.once('error', (error) => {
    spawnError = error;
  });

  while (now() < deadline) {
    if (spawnError) throw new Error(`Metro failed to start: ${spawnError.message}`);
    if (metroExited(child)) throw new Error('Metro exited before becoming ready.');
    const remainingBeforeFetch = deadline - now();
    if (remainingBeforeFetch <= 0) break;
    try {
      const response = await fetchImpl(METRO_STATUS_URL, {
        signal: abortSignalTimeout(Math.min(2_000, remainingBeforeFetch))
      });
      if (response.ok && (await response.text()).includes('packager-status:running')) return;
    } catch {
      // Metro commonly refuses connections while its first bundle graph initializes.
    }
    const remainingBeforeSleep = deadline - now();
    if (remainingBeforeSleep <= 0) break;
    await sleepImpl(Math.min(1_000, remainingBeforeSleep));
  }
  if (spawnError) throw new Error(`Metro failed to start: ${spawnError.message}`);
  if (metroExited(child)) throw new Error('Metro exited before becoming ready.');
  throw new Error('Metro did not become ready within 90 seconds.');
}

async function runCommand(request, environment = process.env) {
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: environment,
    shell: false,
    stdio: 'inherit'
  });
  const [status, signal] = await once(child, 'exit');
  if ((status ?? 1) !== 0) {
    const signalDetail = signal ? ` (${signal})` : '';
    throw new Error(`${path.basename(request.command)} exited with status ${status ?? 1}${signalDetail}.`);
  }
}

async function terminateHostedAndroidMetro(child, options = {}) {
  if (!child?.pid || metroExited(child)) return;
  const kill = options.kill ?? process.kill.bind(process);
  const sleepImpl = options.sleepImpl ?? sleep;
  const isExited = options.isExited ?? metroExited;
  try {
    kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
    return;
  }
  await Promise.race([once(child, 'exit'), sleepImpl(5_000)]);
  if (!isExited(child)) {
    try {
      kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

export async function runHostedAndroidE2e(environment = process.env, dependencies = {}) {
  const plan = createHostedAndroidCommandPlan(environment, dependencies.platform ?? process.platform);
  const log = (dependencies.createLog ?? createHostedAndroidLog)(plan.config.logFile);
  const metro = (dependencies.startMetro ?? startMetro)(plan.metro, environment, log);
  const waitForMetro = dependencies.waitForMetro ?? waitForHostedAndroidMetro;
  const execute = dependencies.runCommand ?? runCommand;
  const terminateMetro = dependencies.terminateMetro ?? terminateHostedAndroidMetro;
  try {
    await waitForMetro(metro);
    await execute(plan.install, environment);
    await execute(plan.e2e, environment);
  } catch (error) {
    const message = redactHostedAndroidDiagnostics(error instanceof Error ? error.message : String(error));
    console.error(`[hosted-android-e2e] ${message}`);
    const diagnostics = log.diagnostics();
    if (diagnostics) console.error(`[hosted-android-e2e] Metro log tail:\n${diagnostics}`);
    throw error;
  } finally {
    await terminateMetro(metro);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runHostedAndroidE2e().catch(() => {
    process.exitCode = 1;
  });
}
