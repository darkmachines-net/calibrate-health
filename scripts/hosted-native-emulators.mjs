#!/usr/bin/env node
/** @file Bounded GitHub Actions emulator lifecycle for the paired phone/watch test environment. */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const HOSTED_ANDROID_CMDLINE_TOOLS_VERSION = '15859902';
export const HOSTED_WEAR_API_LEVEL = '35-ext15';
export const HOSTED_WEAR_SYSTEM_IMAGE = `system-images;android-${HOSTED_WEAR_API_LEVEL};android-wear;x86_64`;
export const HOSTED_WEAR_AVD = 'calibrate-wear-upgrade';
export const HOSTED_WEAR_SERIAL = 'emulator-5556';
const HOSTED_WEAR_PORT = '5556';
const BOOT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 1_000;

function executableName(name, platform) {
  return platform === 'win32' ? `${name}.exe` : name;
}

/** Requires GitHub Actions Linux with explicit Android SDK and temporary workspace configuration. */
export function assertHostedNativeRunner(environment = process.env) {
  if (environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_OS !== 'Linux') {
    throw new Error('Hosted native emulator lifecycle is restricted to GitHub Actions Linux runners.');
  }
  if (!environment.ANDROID_HOME?.trim()) throw new Error('ANDROID_HOME is required.');
  if (!environment.RUNNER_TEMP?.trim()) throw new Error('RUNNER_TEMP is required.');
}

function resolveHostedWearConfiguration(environment = process.env, platform = process.platform) {
  assertHostedNativeRunner(environment);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const sdkRoot = environment.ANDROID_HOME.trim();
  const commandLineTools = pathApi.join(sdkRoot, 'cmdline-tools', HOSTED_ANDROID_CMDLINE_TOOLS_VERSION, 'bin');
  return {
    avdName: HOSTED_WEAR_AVD,
    serial: HOSTED_WEAR_SERIAL,
    systemImage: HOSTED_WEAR_SYSTEM_IMAGE,
    sdkmanager: pathApi.join(commandLineTools, executableName('sdkmanager', platform)),
    avdmanager: pathApi.join(commandLineTools, executableName('avdmanager', platform)),
    adb: pathApi.join(sdkRoot, 'platform-tools', executableName('adb', platform)),
    emulator: pathApi.join(sdkRoot, 'emulator', executableName('emulator', platform)),
    logFile: pathApi.join(environment.RUNNER_TEMP.trim(), 'calibrate-wear-upgrade-emulator.log')
  };
}

/** Builds the hosted Wear emulator preparation and lifecycle commands from validated runner configuration. */
export function createHostedWearCommandPlan(environment = process.env, platform = process.platform) {
  const config = resolveHostedWearConfiguration(environment, platform);
  return {
    config,
    prepare: [
      {
        command: config.sdkmanager,
        args: ['--install', 'emulator', 'platform-tools', config.systemImage]
      },
      {
        command: config.avdmanager,
        args: [
          'create', 'avd', '--force', '--name', config.avdName,
          '--package', config.systemImage
        ],
        input: 'no\n'
      }
    ],
    start: {
      command: config.emulator,
      args: [
        '-avd', config.avdName,
        '-port', HOSTED_WEAR_PORT,
        '-no-window',
        '-gpu', 'swiftshader_indirect',
        '-no-snapshot',
        '-wipe-data',
        '-noaudio',
        '-no-boot-anim',
        '-memory', '1024',
        '-cores', '2'
      ]
    },
    wait: {
      command: config.adb,
      args: ['-s', config.serial, 'wait-for-device']
    },
    stop: {
      command: config.adb,
      args: ['-s', config.serial, 'emu', 'kill']
    }
  };
}

function runCommand(request, options = {}) {
  const result = spawnSync(request.command, request.args, {
    encoding: 'utf8',
    input: request.input,
    timeout: options.timeout,
    stdio: request.input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    shell: false
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0 && !options.allowFailure) {
    throw new Error(`${path.basename(request.command)} exited with status ${result.status ?? 1}.`);
  }
  return result;
}

function adbOutput(config, args, options = {}) {
  const result = spawnSync(config.adb, ['-s', config.serial, ...args], {
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });
  if (result.error && !options.allowFailure) throw result.error;
  if ((result.status ?? 1) !== 0 && !options.allowFailure) {
    throw new Error(`adb ${args.join(' ')} failed without retaining device output.`);
  }
  return result.stdout?.trim() ?? '';
}

function prepareHostedWearAvd(environment = process.env) {
  const plan = createHostedWearCommandPlan(environment);
  for (const request of plan.prepare) runCommand(request);
}

function startHostedWearAvd(environment = process.env) {
  const { config, start } = createHostedWearCommandPlan(environment);
  if (adbOutput(config, ['get-state'], { allowFailure: true }) === 'device') {
    throw new Error(`${config.serial} is already occupied; refusing to replace an unknown adb target.`);
  }
  fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
  const log = fs.openSync(config.logFile, 'w');
  try {
    const child = spawn(start.command, start.args, {
      detached: true,
      env: environment,
      stdio: ['ignore', log, log],
      shell: false
    });
    if (!child.pid) throw new Error('Wear emulator did not start.');
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}

function waitForHostedWearAvd(environment = process.env) {
  const { config, wait } = createHostedWearCommandPlan(environment);
  runCommand(wait, { timeout: BOOT_TIMEOUT_MS });
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (adbOutput(config, ['shell', 'getprop', 'sys.boot_completed'], { allowFailure: true }) === '1') {
      const qemu = adbOutput(config, ['shell', 'getprop', 'ro.kernel.qemu']);
      const characteristics = adbOutput(config, ['shell', 'getprop', 'ro.build.characteristics']);
      if (qemu !== '1' || !characteristics.split(',').includes('watch')) {
        throw new Error(`${config.serial} did not boot as a Wear emulator.`);
      }
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_INTERVAL_MS);
  }
  throw new Error('Timed out waiting for the hosted Wear emulator to finish booting.');
}

function stopHostedWearAvd(environment = process.env) {
  const { stop } = createHostedWearCommandPlan(environment);
  runCommand(stop, { allowFailure: true, timeout: 30_000 });
}

/** Accepts exactly one supported Wear emulator lifecycle command. */
export function parseHostedNativeEmulatorCommand(argv) {
  if (argv.length !== 1 || !['prepare-wear', 'start-wear', 'wait-wear', 'stop-wear'].includes(argv[0])) {
    throw new Error('Usage: node scripts/hosted-native-emulators.mjs <prepare-wear|start-wear|wait-wear|stop-wear>');
  }
  return argv[0];
}

function main() {
  const command = parseHostedNativeEmulatorCommand(process.argv.slice(2));
  if (command === 'prepare-wear') prepareHostedWearAvd();
  else if (command === 'start-wear') startHostedWearAvd();
  else if (command === 'wait-wear') waitForHostedWearAvd();
  else stopHostedWearAvd();
  console.log(`[hosted-native-emulator] ${command} complete.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
