/** @file Explicit Expo OTA export, compatibility checks, publication, and channel readback. */

/** Publish client-only Expo updates; fingerprint runtimes select compatible installed binaries. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readNativeOtaBaseline
} from './native-ota-contract.mjs';
import { resolveExpoRuntime } from './expo-runtime.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const IGNORED_LOCAL_STATUS_PREFIXES = Object.freeze([
  '.codex-remote-attachments/',
  '.codex-screenshots/'
]);

/** Require a value for the preceding CLI option. */
function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

/** Parse the client-only OTA command and reject unsupported options. */
export function parseNativeOtaArgs(argv) {
  const values = {
    baseline: null,
    channel: null,
    environment: null,
    message: null,
    nonInteractive: false,
    dryRun: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--non-interactive') values.nonInteractive = true;
    else if (option === '--dry-run') values.dryRun = true;
    else if (option === '--help' || option === '-h') values.help = true;
    else if (option === '--baseline') values.baseline = requiredValue(argv, index++, option);
    else if (option === '--channel') values.channel = requiredValue(argv, index++, option);
    else if (option === '--environment') values.environment = requiredValue(argv, index++, option);
    else if (option === '--message') values.message = requiredValue(argv, index++, option);
    else throw new Error(`Unknown native OTA option: ${option}`);
  }
  return values;
}

/** Provide injectable command execution for local OTA tooling. */
function createNativeOtaRunner() {
  return function runCommand(request) {
    const invocation = { command: request.command, args: request.args ?? [] };
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: request.cwd,
      env: request.env,
      encoding: request.inherit ? undefined : 'utf8',
      stdio: request.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    if (result.error) throw result.error;
    const response = {
      status: result.status ?? 1,
      stdout: request.inherit ? '' : result.stdout ?? '',
      stderr: request.inherit ? '' : result.stderr ?? ''
    };
    if (response.status !== 0 && !request.allowFailure) {
      const detail = response.stderr.trim() || response.stdout.trim() || `exit ${response.status}`;
      throw new Error(`${request.label ?? request.command} failed: ${detail}`);
    }
    return response;
  };
}

/** Use the repository-pinned EAS CLI rather than a global installation. */
export function resolveLockedEasCliInvocation(root, args, options = {}) {
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const fileExists = options.fileExists ?? fs.existsSync;
  const entryPoint = path.resolve(
    root,
    'tools',
    'eas-cli',
    'node_modules',
    'eas-cli',
    'bin',
    'run'
  );
  if (!fileExists(entryPoint)) {
    throw new Error(
      'The checked-in EAS CLI tool is not installed. From the repository root, run ' +
      '`npm run native:setup` and retry.'
    );
  }
  return { command: nodeExecutable, args: [entryPoint, ...args], entryPoint };
}

/** Read source identity through the injected Git command runner. */
function gitRequest(root, args, label, allowFailure = false) {
  return { command: 'git', args, cwd: root, label, allowFailure };
}

/** Interpret changed paths before allowing a source-bound publication. */
export function parseDirtyPaths(statusOutput) {
  return statusOutput.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).replaceAll('\\', '/'))
    .map((file) => file.includes(' -> ') ? file.split(' -> ').at(-1) : file)
    .filter((file) => !IGNORED_LOCAL_STATUS_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

/** Construct an explicit runtime-targeted Android update command. */
export function nativeOtaPublishCommand(config, baseline, options = {}) {
  const channel = config.channel ?? baseline.channel;
  if (channel !== baseline.channel) {
    throw new Error(
      `This installed build is pinned to the ${baseline.channel} channel; rebuild it to use ${channel}.`
    );
  }
  const environment = config.environment ?? (channel === 'production' ? 'production' : 'preview');
  const args = [
    'update',
    '--channel', channel,
    '--message', config.message,
    '--environment', environment,
    '--platform', 'android'
  ];
  if (config.nonInteractive) args.push('--non-interactive');
  return {
    ...resolveLockedEasCliInvocation(options.root ?? repositoryRoot, args, options),
    channel,
    environment
  };
}

/** Read EAS dotenv output without evaluating shell expressions. */
export function parseEasEnvironmentFile(contents) {
  const values = {};
  for (const originalLine of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trimEnd();
    }
    values[match[1]] = value;
  }
  return values;
}

/** Require the public EAS environment to match the selected local target. */
export function validateEasUpdateEnvironment(values, baseline, environmentName) {
  const expected = {
    EXPO_PUBLIC_CALIBRATE_SERVER_URL: baseline.server_url,
    EXPO_PUBLIC_EAS_PROJECT_ID: baseline.project_id,
    EXPO_UPDATES_CHANNEL: baseline.channel
  };
  for (const [name, expectedValue] of Object.entries(expected)) {
    const actualValue = values[name]?.trim();
    if (!actualValue) {
      throw new Error(
        `EAS environment ${environmentName} does not define ${name}. Set it to ${expectedValue} before publishing this OTA.`
      );
    }
    if (actualValue !== expectedValue) {
      throw new Error(
        `EAS environment ${environmentName} defines ${name} as ${actualValue}, but the installed build baseline requires ${expectedValue}.`
      );
    }
  }
}

/** Read and verify public EAS configuration before source export. */
function verifyEasUpdateEnvironment({ root, baseline, publish, runner, environment }) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-eas-environment-'));
  const environmentFile = path.join(temporaryDirectory, '.env');
  try {
    runner({
      command: publish.command,
      args: [
        publish.entryPoint,
        'env:pull',
        '--environment', publish.environment,
        '--path', environmentFile,
        '--non-interactive'
      ],
      cwd: path.join(root, 'mobile'),
      env: environment,
      label: `read EAS ${publish.environment} environment`
    });
    validateEasUpdateEnvironment(
      parseEasEnvironmentFile(fs.readFileSync(environmentFile, 'utf8')),
      baseline,
      publish.environment
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Describe the exact OTA source in its default release message. */
function defaultMessage(runner, root) {
  const commit = runner(gitRequest(root, ['rev-parse', '--short', 'HEAD'], 'read current commit')).stdout.trim();
  const subject = runner(gitRequest(root, ['log', '-1', '--pretty=%s'], 'read current commit message')).stdout.trim();
  return `Calibrate ${commit}: ${subject}`;
}

/** Show supported commands without reading credentials or performing release work. */
function printHelp() {
  process.stdout.write(`Usage: npm run ota:publish -- [options]

Publish Android JavaScript/assets for the current source fingerprint runtime.

Options:
  --message <text>             Update message (default: current Git commit subject)
  --channel <name>             Target channel (defaults to the local build configuration)
  --environment <name>         EAS environment (default: preview, or production for production channel)
  --baseline <path>            Override the recorded local native-build baseline
  --non-interactive            Require token-based EAS authentication and disable CLI prompts
  --dry-run                    Validate the source runtime and EAS environment without uploading
  --help                       Show this help

Native module/configuration and Wear OS changes cannot be delivered by Expo OTA.
`);
}

/** Require a clean publication source and resolve its current fingerprint runtime. */
function validateNativeOtaState({ root, baseline, runner, environment = process.env }) {
  const mobilePackage = JSON.parse(fs.readFileSync(path.join(root, 'mobile', 'package.json'), 'utf8'));
  if (!mobilePackage.dependencies?.['expo-updates']) {
    throw new Error('mobile/package.json does not include expo-updates. A new native build is required.');
  }

  const status = runner(gitRequest(
    root,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    'inspect OTA working tree'
  ));
  const dirtyPaths = parseDirtyPaths(status.stdout);
  if (dirtyPaths.length > 0) {
    throw new Error(`Commit OTA contents before publishing. Dirty paths: ${dirtyPaths.slice(0, 8).join(', ')}`);
  }

  if (environment.EXPO_PUBLIC_EAS_PROJECT_ID &&
      environment.EXPO_PUBLIC_EAS_PROJECT_ID.trim() !== baseline.project_id) {
    throw new Error('EXPO_PUBLIC_EAS_PROJECT_ID does not match the installed build baseline.');
  }

}

/** Publish or describe a client-only update using the locked EAS toolchain. */
export function runNativeOtaUpdate(options = {}) {
  const root = options.repositoryRoot ?? repositoryRoot;
  const environment = options.environment ?? process.env;
  const config = options.config ?? parseNativeOtaArgs(process.argv.slice(2));
  if (config.help) {
    printHelp();
    return { help: true };
  }
  const runner = options.runner ?? createNativeOtaRunner();
  let saved;
  try { saved = readNativeOtaBaseline(root, config.baseline); }
  catch (error) {
    if (config.baseline || !/baseline is missing/.test(error.message)) throw error;
    const app = JSON.parse(fs.readFileSync(path.join(root, 'mobile/app.json'), 'utf8')).expo;
    saved = { file: 'configured Expo target', baseline: {
      project_id: environment.EXPO_PUBLIC_EAS_PROJECT_ID || app.extra?.eas?.projectId,
      channel: config.channel || environment.EXPO_UPDATES_CHANNEL || 'internal',
      server_url: environment.EXPO_PUBLIC_CALIBRATE_SERVER_URL
    } };
  }
  const { file: baselineFile, baseline } = saved;
  validateNativeOtaState({ root, baseline, runner, environment });
  if (config.nonInteractive && !environment.EXPO_TOKEN?.trim()) {
    throw new Error('--non-interactive requires EXPO_TOKEN. Use interactive mode to sign in with EAS CLI.');
  }

  const resolvedConfig = { ...config, message: config.message?.trim() || defaultMessage(runner, root) };
  const publish = nativeOtaPublishCommand(resolvedConfig, baseline, {
    root,
    nodeExecutable: options.nodeExecutable,
    fileExists: options.fileExists
  });
  const publishEnvironment = {
    ...environment,
    NODE_ENV: 'production',
    EXPO_NO_METRO_WORKSPACE_ROOT: '1',
    EXPO_PUBLIC_CALIBRATE_SERVER_URL: baseline.server_url,
    EXPO_PUBLIC_EAS_PROJECT_ID: baseline.project_id,
    EXPO_UPDATES_CHANNEL: baseline.channel
  };
  verifyEasUpdateEnvironment({
    root,
    baseline,
    publish,
    runner,
    environment: publishEnvironment
  });
  baseline.runtime_version = (options.resolveRuntime ?? resolveExpoRuntime)(root, { environment: publishEnvironment });
  process.stdout.write(
    `OTA targeting defaults: ${baselineFile}\n` +
    `Runtime: ${baseline.runtime_version} | Channel: ${publish.channel} | Environment: ${publish.environment}\n` +
    'EAS environment contract: verified\n' +
    `Message: ${resolvedConfig.message}\n`
  );
  if (config.dryRun) {
    process.stdout.write(`Dry run: ${publish.command} ${publish.args.join(' ')}\n`);
    return { baseline, publish, dryRun: true };
  }

  runner({
    command: publish.command,
    args: publish.args,
    cwd: path.join(root, 'mobile'),
    env: publishEnvironment,
    label: 'publish Expo OTA update',
    inherit: true
  });
  process.stdout.write('Android OTA update published. Wear OS was not changed.\n');
  return { baseline, publish, dryRun: false };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runNativeOtaUpdate();
  } catch (error) {
    console.error(`[native-ota] ${error.message}`);
    process.exitCode = 1;
  }
}
