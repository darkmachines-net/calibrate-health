/** @file Windows native-tool prerequisite inspection and verified tool installation for repository-owned commands. */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertNativeNodeVersion, captureNativeTool, findNativeSdkManager, inspectNativeToolchain,
  NATIVE_SDK_PACKAGES, NATIVE_TOOLCHAIN, NATIVE_TOOL_DOWNLOADS, nativeFileSha256
} from './native-toolchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NATIVE_ENVIRONMENT_KEYS = Object.freeze(['JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'BUNDLETOOL_JAR']);
// Bound stalled downloads while allowing a full JDK archive on slower connections.
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// Bound archive extraction and registry operations in an unattended setup.
const POWERSHELL_TIMEOUT_MS = 2 * 60 * 1000;
const POWERSHELL = 'powershell.exe';
const ENVIRONMENT_REFRESH = "foreach ($name in 'JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT','BUNDLETOOL_JAR') { Set-Item \"Env:$name\" ([Environment]::GetEnvironmentVariable($name, 'User')) }";
const HELP = [
  'Prepare the Windows x64 Android phone/Wear build tools (no signing or publishing).',
  '  npm run native:setup                     Install missing tools and host dependencies.',
  '  npm run native:setup -- --check          Check all prerequisites without changes or downloads.',
  '  npm run native:setup -- --skip-deps      Install/check only the Android toolchain.',
  '  npm run native:setup -- --accept-licenses  Accept licenses for the SDK packages being installed.',
  'Node ' + NATIVE_TOOLCHAIN.nodeMinimum + '+ and Git must already be installed.',
  'SDK license: https://developer.android.com/studio/terms'
].join('\n');

/** Accepts only supported native setup flags and rejects duplicate options. */
export function parseNativeSetupArguments(argv) {
  const options = { check: false, skipDeps: false, acceptLicenses: false, help: false };
  const flags = { '--check': 'check', '--skip-deps': 'skipDeps', '--accept-licenses': 'acceptLicenses', '--help': 'help', '-h': 'help' };
  for (const argument of argv) {
    const key = flags[argument];
    if (!key || options[key]) throw new Error('Unknown or duplicate native setup option: ' + argument);
    options[key] = true;
  }
  if (options.check && options.acceptLicenses) throw new Error('--check cannot accept licenses or change the SDK.');
  return options;
}

/** Removes signing, Play, and Expo credentials from prerequisite installation environments. */
export function nativeSetupEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => {
    const key = name.toUpperCase();
    return !key.startsWith('CALIBRATE_ANDROID_') && !key.startsWith('GOOGLE_PLAY_') &&
      !['GOOGLE_APPLICATION_CREDENTIALS', 'EXPO_TOKEN'].includes(key);
  }));
}

function powershell(script, environment, input) {
  const utf8 = '[Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n';
  const result = spawnSync(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', utf8 + script], {
    env: environment, input, encoding: 'utf8', windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    throw new Error('Native setup PowerShell operation failed: ' + (result.stderr?.trim() || 'PowerShell is unavailable.'));
  }
  return result.stdout.trim();
}

/** Reads only the allowlisted Windows user-level Java and Android tool variables. */
export function readNativeUserEnvironment(environment) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$values = @{}',
    'foreach ($name in @("JAVA_HOME","ANDROID_HOME","ANDROID_SDK_ROOT","BUNDLETOOL_JAR")) {',
    '  $value = [Environment]::GetEnvironmentVariable($name, "User")',
    '  if ($value) { $values[$name] = $value }',
    '}',
    'ConvertTo-Json -InputObject $values -Compress'
  ].join('\n');
  return JSON.parse(powershell(script, environment));
}

function saveNativeUserEnvironment(values, environment) {
  const selected = Object.fromEntries(NATIVE_ENVIRONMENT_KEYS.map((key) => {
    if (typeof values[key] !== 'string' || !path.isAbsolute(values[key])) {
      throw new Error('Cannot save a relative or missing ' + key + '.');
    }
    return [key, values[key]];
  }));
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$values = [Console]::In.ReadToEnd() | ConvertFrom-Json',
    'foreach ($name in @("JAVA_HOME","ANDROID_HOME","ANDROID_SDK_ROOT","BUNDLETOOL_JAR")) {',
    '  if ([Environment]::GetEnvironmentVariable($name, "User") -ne $values.$name) {',
    '    [Environment]::SetEnvironmentVariable($name, $values.$name, "User")',
    '  }',
    '  if ([Environment]::GetEnvironmentVariable($name, "User") -ne $values.$name) { throw "Environment readback failed: $name" }',
    '}'
  ].join('\n');
  powershell(script, environment, JSON.stringify(selected));
}

/** Downloads a pinned native tool through a temporary file and validates it before publishing the destination. */
export async function downloadNativeTool(artifact, destination, fetchImpl = fetch) {
  if (fs.existsSync(destination)) throw new Error('Download destination already exists: ' + destination);
  const temporary = destination + '.partial-' + randomUUID();
  try {
    const response = await fetchImpl(artifact.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !response.body) throw new Error('Download returned HTTP ' + response.status + ': ' + artifact.url);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: 'wx' }));
    if (nativeFileSha256(temporary) !== artifact.sha256) {
      throw new Error('Downloaded tool failed its pinned SHA-256 check: ' + artifact.url);
    }
    if (fs.existsSync(destination)) throw new Error('Download destination appeared during setup: ' + destination);
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function removeStagingDirectory(parent, directory) {
  if (!isWithin(fs.realpathSync(parent), fs.realpathSync(directory)) ||
      !path.basename(directory).startsWith('.calibrate-native-')) {
    throw new Error('Refusing to remove a directory outside native setup staging.');
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

/** Extracts an archive into a new directory using environment-supplied paths rather than interpolated shell code. */
export function extractNativeArchive(archive, destination, environment) {
  if (fs.existsSync(destination)) throw new Error('Archive extraction destination already exists.');
  // Paths arrive through the child environment, never by interpolating them into PowerShell code.
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.IO.Compression',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$destination = [IO.Path]::GetFullPath($env:CALIBRATE_NATIVE_SETUP_DESTINATION)',
    '$prefix = $destination.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar',
    '$zip = [IO.Compression.ZipFile]::OpenRead($env:CALIBRATE_NATIVE_SETUP_ARCHIVE)',
    'try {',
    '  foreach ($entry in $zip.Entries) {',
    '    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($destination, $entry.FullName))',
    '    if ([IO.Path]::IsPathRooted($entry.FullName) -or !$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {',
    '      throw "Archive entry escapes the setup directory."',
    '    }',
    '    if ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw "Archive links are unsupported." }',
    '  }',
    '} finally { $zip.Dispose() }'
  ].join('\n');
  powershell(script, {
    ...environment, CALIBRATE_NATIVE_SETUP_ARCHIVE: archive, CALIBRATE_NATIVE_SETUP_DESTINATION: destination
  });
  // Windows tar supports SDK paths that exceed the legacy .NET Framework extraction limit.
  fs.mkdirSync(destination, { recursive: true });
  const tar = path.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe');
  runSetupCommand(tar, ['-xf', archive, '-C', destination], environment, {
    label: 'Windows archive extraction', timeout: POWERSHELL_TIMEOUT_MS
  });
}

/** Installs a verified archive through a staging directory and refuses to overwrite an existing tool installation. */
export async function installNativeArchive(artifact, destination, environment, dependencies = {}) {
  if (fs.existsSync(destination)) {
    throw new Error('Existing tool directory is incomplete or unsupported: ' + destination + '. Move it aside and rerun setup.');
  }
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.calibrate-native-'));
  try {
    const archive = path.join(staging, 'tool.zip');
    await (dependencies.download ?? downloadNativeTool)(artifact, archive);
    const extracted = path.join(staging, 'extracted');
    (dependencies.extract ?? extractNativeArchive)(archive, extracted, environment);
    const source = path.join(extracted, artifact.root);
    if (!isWithin(staging, source) || !isWithin(parent, destination) || !fs.statSync(source).isDirectory()) {
      throw new Error('Unexpected tool archive layout.');
    }
    fs.renameSync(source, destination);
  } finally { removeStagingDirectory(parent, staging); }
}

function runSetupCommand(command, args, environment, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.root ?? ROOT, env: environment, windowsHide: true,
    stdio: [options.input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    input: options.input, timeout: options.timeout
  });
  if (result.error || result.status !== 0) {
    throw new Error((options.label ?? path.basename(command)) + ' failed. Review the output above and rerun setup.');
  }
}

function java17Available(javaHome, environment, capture) {
  if (!javaHome) return false;
  try {
    return /^(?:openjdk|java) 17\./.test(capture(path.join(javaHome, 'bin/java.exe'), ['--version'], environment)) &&
      /^javac 17\./.test(capture(path.join(javaHome, 'bin/javac.exe'), ['--version'], environment)) &&
      ['jar.exe', 'keytool.exe'].every((name) => fs.existsSync(path.join(javaHome, 'bin', name)));
  } catch { return false; }
}

function inspectNativeGit(environment, capture) {
  try {
    const version = capture('git', ['--version'], environment);
    if (/^git version \d+\.\d+\.\d+(?:[.\s]|$)/.test(version)) {
      return { name: 'Git', ok: true, detail: version };
    }
  } catch { /* Report setup guidance without exposing tool stderr. */ }
  return { name: 'Git', ok: false,
    detail: 'Install Git for Windows and ensure git is on PATH. Reopen the terminal and rerun npm run native:setup.' };
}

/** Inspect the shared official provider cache; the toolkit owns its installation. */
export function inspectNativeEasDependency(root) {
  try {
    const shared = createRequire(path.join(root, 'package.json'))('@mchartier/expo-release');
    if (fs.existsSync(shared.resolveEasCli())) return { name: 'EAS CLI', ok: true, detail: 'Installed in shared provider cache' };
  } catch { /* Host dependency setup installs the pinned package before this check. */ }
  return { name: 'EAS CLI', ok: false, detail: 'Run npm run release -- setup to install the pinned official provider tools.' };
}

/** Install or reuse the official provider cache through the pinned shared toolkit. */
export function ensureNativeEasDependency(root) {
  let shared;
  try { shared = createRequire(path.join(root, 'package.json'))('@mchartier/expo-release'); }
  catch { throw new Error('Install the pinned shared release package before provider setup.'); }
  shared.setupToolchain();
}

/** Reports missing host prerequisites needed by native setup without modifying them. */
export function inspectNativeHostDependencies(root) {
  const missing = ['node_modules/expo/package.json', 'shared/dist/cjs/releaseCompatibility.js']
    .filter((file) => !fs.existsSync(path.join(root, file)));
  return { name: 'Host dependencies', ok: missing.length === 0,
    detail: missing.length ? 'Run npm run native:setup. Missing: ' + missing.join(', ') : 'Installed' };
}

/** Checks or installs supported Windows native prerequisites using credential-free dependency setup. */
export async function setupNative(argv = [], options = {}) {
  const args = parseNativeSetupArguments(argv);
  const log = options.log ?? console.log;
  if (args.help) { log(HELP); return { ok: true }; }
  if ((options.platform ?? process.platform) !== 'win32' || (options.arch ?? process.arch) !== 'x64') {
    throw new Error('Automatic native setup currently supports Windows x64. See scripts/README.md#play-onboarding.');
  }
  assertNativeNodeVersion(options.nodeVersion);
  const root = options.root ?? ROOT;
  const inherited = options.environment ?? process.env;
  const safe = nativeSetupEnvironment(inherited);
  const saved = (options.readUserEnvironment ?? readNativeUserEnvironment)(safe);
  // Explicit process settings take precedence; saved values support terminals opened before the last setup.
  const environment = { ...safe };
  for (const key of NATIVE_ENVIRONMENT_KEYS) environment[key] ||= saved[key];
  for (const key of NATIVE_ENVIRONMENT_KEYS) {
    if (environment[key] && !path.isAbsolute(environment[key])) throw new Error(key + ' must be an absolute path.');
  }
  if (!environment.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required for Windows user-scoped native tools.');
  const sdkRoot = path.resolve(environment.ANDROID_HOME || environment.ANDROID_SDK_ROOT ||
    path.join(environment.LOCALAPPDATA, 'Android', 'Sdk'));
  environment.ANDROID_HOME = sdkRoot;
  environment.ANDROID_SDK_ROOT = sdkRoot;
  environment.BUNDLETOOL_JAR ||= path.join(sdkRoot, 'tools', 'bundletool-all-' + NATIVE_TOOLCHAIN.bundletool + '.jar');
  const capture = options.capture ?? captureNativeTool;
  const inspect = options.inspect ?? inspectNativeToolchain;
  const run = options.run ?? runSetupCommand;
  const install = options.installArchive ?? installNativeArchive;
  const download = options.download ?? downloadNativeTool;
  const hostCheck = options.hostCheck ?? inspectNativeHostDependencies;
  const easCheck = options.easCheck ?? inspectNativeEasDependency;
  const gitCheck = inspectNativeGit(environment, capture);
  if (!args.check && !gitCheck.ok) throw new Error(gitCheck.detail);

  if (!args.check) {
    const managedJava = path.join(environment.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium', NATIVE_TOOL_DOWNLOADS.java.root);
    if (!java17Available(environment.JAVA_HOME, environment, capture)) {
      environment.JAVA_HOME = managedJava;
      if (!java17Available(managedJava, environment, capture)) {
        log('[native-setup] Installing checksum-pinned Temurin JDK 17.');
        await install(NATIVE_TOOL_DOWNLOADS.java, managedJava, environment);
      }
    }
    if (!java17Available(environment.JAVA_HOME, environment, capture)) throw new Error('Installed JDK 17 could not run.');
    log('[native-setup] JDK 17 ready: ' + environment.JAVA_HOME);
    if (!findNativeSdkManager(sdkRoot)) {
      log('[native-setup] Installing checksum-pinned Android command-line tools ' + NATIVE_TOOLCHAIN.commandLineTools + '.');
      await install(NATIVE_TOOL_DOWNLOADS.commandLineTools,
        path.join(sdkRoot, 'cmdline-tools', NATIVE_TOOLCHAIN.commandLineTools), environment);
    }
    if (!fs.existsSync(environment.BUNDLETOOL_JAR)) {
      log('[native-setup] Installing checksum-pinned bundletool ' + NATIVE_TOOLCHAIN.bundletool + '.');
      fs.mkdirSync(path.dirname(environment.BUNDLETOOL_JAR), { recursive: true });
      await download(NATIVE_TOOL_DOWNLOADS.bundletool, environment.BUNDLETOOL_JAR);
    }
    const missingPackages = inspect(environment).filter((check) => !check.ok && NATIVE_SDK_PACKAGES[check.name])
      .map((check) => NATIVE_SDK_PACKAGES[check.name]);
    if (missingPackages.length) {
      log('[native-setup] Installing SDK packages: ' + missingPackages.join(', '));
      log('[native-setup] Accept the requested SDK licenses, or use --accept-licenses for an unattended install.');
      // Invoke Java directly so SDK package semicolons and paths with spaces never go through cmd.exe.
      run(path.join(environment.JAVA_HOME, 'bin/java.exe'), [
        '-classpath', findNativeSdkManager(sdkRoot), 'com.android.sdklib.tool.sdkmanager.SdkManagerCli',
        '--sdk_root=' + sdkRoot, '--install', ...missingPackages
      ], environment, { root, input: args.acceptLicenses ? 'y\n'.repeat(20) : undefined, label: 'Android SDK installation' });
    } else {
      log('[native-setup] Required SDK packages are already installed.');
    }
    const toolFailures = inspect(environment).filter((check) => !check.ok);
    if (toolFailures.length) throw new Error(toolFailures.map((check) => check.name + ': ' + check.detail).join('\n'));
    if (!args.skipDeps) {
      log('[native-setup] Running repository host setup and building shared code.');
      run(process.execPath, [path.join(root, 'scripts/dev-env.mjs'), 'setup:host'], environment, { root });
      const npmCli = inherited.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
      if (!fs.existsSync(npmCli)) throw new Error('Cannot locate npm-cli.js. Run setup through npm run native:setup.');
      run(process.execPath, [npmCli, '--prefix', path.join(root, 'shared'), 'run', 'build'], environment, { root });
      (options.ensureEas ?? ensureNativeEasDependency)(root);
    }
  }
  const checks = [gitCheck, ...inspect(environment)];
  if (!args.skipDeps) checks.push(hostCheck(root), easCheck(root));
  const ok = checks.every((check) => check.ok);
  const values = Object.fromEntries(NATIVE_ENVIRONMENT_KEYS.map((key) => [key, environment[key]]));
  for (const check of checks) log('[native-setup] ' + (check.ok ? 'OK ' : 'MISSING ') + check.name + ': ' +
    (typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail)));
  if (ok && !args.check) {
    (options.saveUserEnvironment ?? saveNativeUserEnvironment)(values, environment);
    log('[native-setup] Saved native tool paths for your Windows account; native commands read them automatically.\n' +
      'For direct tool commands in this PowerShell session, refresh its environment:\n' + ENVIRONMENT_REFRESH);
  }
  log('[native-setup] ' + (ok ? 'Local prerequisites are ready.' : 'Run npm run native:setup to install missing prerequisites.'));
  return { ok, checks, environment: values };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  setupNative(process.argv.slice(2)).then((result) => { if (!result.ok) process.exitCode = 1; })
    .catch((error) => { console.error('[native-setup] ' + error.message); process.exitCode = 1; });
}
