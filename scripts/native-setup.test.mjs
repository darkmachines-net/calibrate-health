/** @file Regression coverage for native setup: setup flags keep check read-only and reject unknown or conflicting options. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  downloadNativeTool, extractNativeArchive, installNativeArchive, NATIVE_ENVIRONMENT_KEYS,
  nativeSetupEnvironment, parseNativeSetupArguments, setupNative, ensureNativeEasDependency, inspectNativeEasDependency
} from './native-setup.mjs';
import {
  assertNativeNodeVersion, inspectNativeToolchain, NATIVE_SDK_PACKAGES, NATIVE_TOOLCHAIN, NATIVE_TOOL_DOWNLOADS
} from './native-toolchain.mjs';

/** Allocate a disposable test directory and register cleanup. */
function temporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-native-setup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Write an isolated test input without depending on application source. */
function write(file, contents = 'fixture') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** Model native tool installation paths independently of the host configuration. */
function setupFixture(t) {
  const root = temporaryDirectory(t);
  const installedPackages = new Set();
  const events = [];
  let saved = {};
  const options = {
    root, platform: 'win32', arch: 'x64', nodeVersion: '22.14.0',
    environment: {
      LOCALAPPDATA: path.join(root, 'Local Programs'),
      CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD: 'signing-sentinel',
      google_play_access_token: 'play-sentinel', EXPO_TOKEN: 'expo-sentinel',
      PATH: process.env.PATH
    },
    log: () => {},
    readUserEnvironment: () => saved,
    saveUserEnvironment: (values) => { events.push(['save']); saved = values; },
    capture: (command) => {
      if (command === 'git') return 'git version 2.50.1.windows.1';
      if (!fs.existsSync(command)) throw new Error('Not installed');
      return command.endsWith('javac.exe') ? 'javac 17.0.20.1' : 'openjdk 17.0.20.1 2026-08-18';
    },
    installArchive: async (artifact, destination, environment) => {
      assert.equal(Object.values(environment).some((value) => String(value).includes('sentinel')), false);
      events.push(['archive', artifact]);
      if (artifact === NATIVE_TOOL_DOWNLOADS.java) {
        for (const executable of ['java', 'javac', 'jar', 'keytool']) write(path.join(destination, 'bin', executable + '.exe'));
      } else {
        write(path.join(destination, 'lib/sdkmanager-classpath.jar'));
        write(path.join(destination, 'source.properties'), 'Pkg.Revision=20.0\n');
      }
    },
    download: async (artifact, destination) => { events.push(['download', artifact]); write(destination, 'verified bundletool'); },
    inspect: (environment) => [
      ...Object.keys(NATIVE_SDK_PACKAGES).map((name) => ({
        name, ok: installedPackages.has(NATIVE_SDK_PACKAGES[name]), detail: 'SDK fixture'
      })),
      { name: 'bundletool', ok: fs.existsSync(environment.BUNDLETOOL_JAR), detail: 'Bundle fixture' }
    ],
    run: (command, args, environment, settings) => {
      assert.equal(Object.values(environment).some((value) => String(value).includes('sentinel')), false);
      events.push(['run', command, args, settings]);
      for (const argument of args) if (Object.values(NATIVE_SDK_PACKAGES).includes(argument)) installedPackages.add(argument);
    },
    hostCheck: () => ({ name: 'Host dependencies', ok: false, detail: 'Missing' }),
    easCheck: () => ({ name: 'EAS CLI', ok: true, detail: 'Installed' }),
    ensureEas: () => events.push(['eas'])
  };
  return { root, options, events, installedPackages };
}

test('setup flags keep check read-only and reject unknown or conflicting options', () => {
  assert.equal(parseNativeSetupArguments(['--check', '--skip-deps']).check, true);
  for (const args of [['--check', '--accept-licenses'], ['--check', '--check'], ['--credentials-file', 'secret']]) {
    assert.throws(() => parseNativeSetupArguments(args));
  }
  assert.throws(() => assertNativeNodeVersion('20.19.0'), /22.14.0/);
  assert.throws(() => assertNativeNodeVersion('22.13.9'), /22.14.0/);
  assert.equal(assertNativeNodeVersion('22.14.0'), '22.14.0');
  assert.equal(assertNativeNodeVersion('24.12.0'), '24.12.0');
});

test('setup subprocesses omit inherited native signing and publishing credentials without changing the caller', () => {
  const input = {
    CALIBRATE_ANDROID_SIGNING_STORE_FILE: 'secret-file', calibrate_android_signing_key_password: 'secret',
    GOOGLE_PLAY_ACCESS_TOKEN: 'secret', google_application_credentials: 'secret', EXPO_TOKEN: 'secret',
    JAVA_HOME: 'Java', PATH: 'tools'
  };
  assert.deepEqual(nativeSetupEnvironment(input), { JAVA_HOME: 'Java', PATH: 'tools' });
  assert.equal(input.CALIBRATE_ANDROID_SIGNING_STORE_FILE, 'secret-file');
});

test('a fresh Windows setup installs tools in order, scopes SDK license answers and saves only public paths', async (t) => {
  const { options, events } = setupFixture(t);
  const result = await setupNative(['--skip-deps', '--accept-licenses'], options);
  assert.equal(result.ok, true);
  assert.deepEqual(events.map(([kind]) => kind), ['archive', 'archive', 'download', 'run', 'save']);
  const [, command, args, settings] = events.find(([kind]) => kind === 'run');
  assert.ok(command.endsWith('java.exe'));
  assert.equal(args[0], '-classpath');
  assert.ok(args.includes('com.android.sdklib.tool.sdkmanager.SdkManagerCli'));
  assert.deepEqual(args.slice(args.indexOf('--install') + 1), Object.values(NATIVE_SDK_PACKAGES));
  assert.match(settings.input, /^y\n/);
  assert.deepEqual(Object.keys(result.environment), [...NATIVE_ENVIRONMENT_KEYS]);
  assert.equal(result.environment.ANDROID_HOME, result.environment.ANDROID_SDK_ROOT);
  assert.equal(JSON.stringify(result).includes('sentinel'), false);

  events.length = 0;
  assert.equal((await setupNative(['--skip-deps'], options)).ok, true);
  assert.deepEqual(events.map(([kind]) => kind), ['save'], 'A second run must not download or reinstall tools');
});

test('check lists missing tools and dependencies without installs, environment writes or network activity', async (t) => {
  const { root, options, events } = setupFixture(t);
  const before = fs.readdirSync(root);
  const result = await setupNative(['--check'], options);
  assert.equal(result.ok, false);
  assert.ok(result.checks.filter((check) => !check.ok).length > 1);
  assert.ok(result.checks.some((check) => check.name === 'Host dependencies' && !check.ok));
  assert.deepEqual(events, []);
  assert.deepEqual(fs.readdirSync(root), before);
});

test('setup and check require runnable Git even when all other prerequisites are installed', async (t) => {
  const { root, options, events } = setupFixture(t);
  const logs = [];
  options.log = (message) => logs.push(message);
  options.hostCheck = () => ({ name: 'Host dependencies', ok: true, detail: 'Installed' });
  options.environment.npm_execpath = path.join(root, 'npm-cli.js');
  write(options.environment.npm_execpath);
  await setupNative([], options);
  const capture = options.capture;
  for (const failure of ['missing', 'nonzero', 'invalid-output']) {
    options.capture = (command, args, environment) => {
      if (command !== 'git') return capture(command, args, environment);
      assert.deepEqual(args, ['--version']);
      assert.equal(environment.PATH, options.environment.PATH);
      assert.equal(environment.CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD, undefined);
      if (failure === 'invalid-output') return 'unexpected-sentinel';
      throw Object.assign(new Error('unexpected-sentinel'), failure === 'missing' ? { code: 'ENOENT' } : { status: 1 });
    };
    for (const args of [[], ['--skip-deps'], ['--check'], ['--check', '--skip-deps']]) {
      events.length = 0;
      logs.length = 0;
      if (args.includes('--check')) {
        const result = await setupNative(args, options);
        assert.equal(result.ok, false);
        assert.deepEqual(result.checks.filter((check) => !check.ok).map((check) => check.name), ['Git']);
        assert.match(result.checks.find((check) => check.name === 'Git').detail, /Install Git.*PATH/);
      } else {
        await assert.rejects(setupNative(args, options), /Install Git.*PATH/);
      }
      assert.deepEqual(events, [], 'Unavailable Git must not trigger installs or settings writes');
      assert.doesNotMatch(logs.join('\n'), /Local prerequisites are ready|unexpected-sentinel/);
    }
  }
  options.capture = capture;
  const ready = await setupNative(['--check'], options);
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.checks.find((check) => check.name === 'Git'), {
    name: 'Git', ok: true, detail: 'git version 2.50.1.windows.1'
  });
});

test('tool installation failure never persists partial settings or runs dependency setup', async (t) => {
  const { options, events } = setupFixture(t);
  options.installArchive = async () => { throw new Error('Network unavailable'); };
  await assert.rejects(setupNative([], options), /Network unavailable/);
  assert.deepEqual(events, []);
});

test('SDK installation keeps license input interactive unless explicitly requested', async (t) => {
  const { options, events } = setupFixture(t);
  await setupNative(['--skip-deps'], options);
  assert.equal(events.find(([kind]) => kind === 'run')[3].input, undefined);
});

test('full setup delegates host installation to existing repo scripts before saving settings', async (t) => {
  const { root, options, events } = setupFixture(t);
  const npmCli = path.join(root, 'npm-cli.js');
  write(npmCli);
  options.environment.npm_execpath = npmCli;
  options.hostCheck = () => ({ name: 'Host dependencies', ok: true, detail: 'Installed' });
  await setupNative([], options);
  const commands = events.filter(([kind]) => kind === 'run').map(([, , args]) => args);
  assert.deepEqual(commands[1], [path.join(root, 'scripts/dev-env.mjs'), 'setup:host']);
  assert.deepEqual(commands[2], [npmCli, '--prefix', path.join(root, 'shared'), 'run', 'build']);
  assert.equal(events.at(-2)[0], 'eas');
  assert.equal(events.at(-1)[0], 'save');
});

test('EAS setup caches the reviewed dependency graph and retries a failed install without a valid stamp', (t) => {
  const root = temporaryDirectory(t);
  const directory = path.join(root, 'tools/eas-cli');
  const lock = path.join(directory, 'package-lock.json');
  const entry = path.join(directory, 'node_modules/eas-cli/bin/run');
  write(path.join(directory, 'package.json'), '{}');
  write(lock, '{"lockfileVersion":3}');
  const commands = [];
  /** Execute the requested build-tool operation through the injected runner. */
  const run = (_command, args, environment) => {
    commands.push(args);
    assert.equal(environment.EXPO_TOKEN, undefined);
    write(entry);
  };
  assert.equal(inspectNativeEasDependency(root).ok, false);
  ensureNativeEasDependency(root, 'npm-cli.js', {}, run, () => {});
  assert.equal(inspectNativeEasDependency(root).ok, true);
  assert.deepEqual(commands[0], ['npm-cli.js', 'ci', '--prefix', directory, '--include=dev', '--no-audit', '--fund=false']);
  ensureNativeEasDependency(root, 'npm-cli.js', {}, run, () => {});
  assert.equal(commands.length, 1);
  write(lock, '{"lockfileVersion":3,"packages":{}}');
  assert.equal(inspectNativeEasDependency(root).ok, false);
  assert.throws(() => ensureNativeEasDependency(root, 'npm-cli.js', {}, () => { throw new Error('offline'); }, () => {}), /offline/);
  assert.equal(inspectNativeEasDependency(root).ok, false);
  ensureNativeEasDependency(root, 'npm-cli.js', {}, run, () => {});
  assert.equal(inspectNativeEasDependency(root).ok, true);
  fs.rmSync(entry);
  assert.equal(inspectNativeEasDependency(root).ok, false);
});

test('all missing toolchain components are reported together and tool stderr cannot leak secrets', (t) => {
  const root = temporaryDirectory(t);
  const checks = inspectNativeToolchain({
    JAVA_HOME: path.join(root, 'java'), ANDROID_HOME: path.join(root, 'sdk'), BUNDLETOOL_JAR: path.join(root, 'bundletool.jar')
  }, { platform: 'win32', capture: () => { throw new Error('secret-sentinel'); } });
  assert.deepEqual(checks.filter((check) => !check.ok).map((check) => check.name), [
    'JDK 17', 'SDK command-line tools', 'SDK platform', 'SDK build-tools', 'Wear SDK build-tools',
    'Wear SDK platform', 'SDK platform-tools', 'NDK', 'CMake', 'bundletool'
  ]);
  assert.equal(JSON.stringify(checks).includes('secret-sentinel'), false);
});

test('download checks SHA-256 before use and removes corrupt or interrupted files', async (t) => {
  const root = temporaryDirectory(t);
  const file = path.join(root, 'download.zip');
  const bytes = Buffer.from('verified archive fixture');
  const artifact = { url: 'https://example.invalid/tool.zip', sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  await downloadNativeTool(artifact, file, async () => new Response(bytes));
  assert.deepEqual(fs.readFileSync(file), bytes);
  await assert.rejects(downloadNativeTool(artifact, file, async () => assert.fail('must not download')), /already exists/);
  fs.rmSync(file);
  await assert.rejects(downloadNativeTool(artifact, file, async () => new Response('corrupt')), /SHA-256/);
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(downloadNativeTool(artifact, file, async () => new Response(null, { status: 503 })), /503/);
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(downloadNativeTool(artifact, file, async () => new Response(new ReadableStream({
    /** Start a controlled test process to exercise setup failures. */
    start(controller) { controller.enqueue(bytes); controller.error(new Error('Interrupted download')); }
  }))), /Interrupted download/);
  assert.deepEqual(fs.readdirSync(root), [], 'No partial download should remain after failure');
});

test('archive installation preserves existing tools and cleans only its own staging directory on failure', async (t) => {
  const root = temporaryDirectory(t);
  const destination = path.join(root, 'java');
  const artifact = { root: 'jdk-fixture' };
  await assert.rejects(installNativeArchive(artifact, destination, {}, {
    download: async () => { throw new Error('checksum mismatch'); },
    extract: () => assert.fail('must not extract')
  }), /checksum mismatch/);
  assert.deepEqual(fs.readdirSync(root), []);
  write(path.join(destination, 'keep.txt'), 'existing');
  await assert.rejects(installNativeArchive(artifact, destination, {}), /Existing tool directory/);
  assert.equal(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'), 'existing');
});

test('archive extraction handles literal Windows paths and rejects entries outside the destination', {
  skip: process.platform !== 'win32'
}, (t) => {
  const root = temporaryDirectory(t);
  const directory = path.join(root, "spaces ' quotes $() & unicode-é");
  fs.mkdirSync(directory);
  const archive = path.join(directory, 'fixture.zip');
  /** Build an archive fixture for extraction-boundary tests. */
  const createZip = (entry, file = archive) => {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.IO.Compression',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      '$zip = [IO.Compression.ZipFile]::Open($env:TEST_ARCHIVE, [IO.Compression.ZipArchiveMode]::Create)',
      'try { $writer = New-Object IO.StreamWriter($zip.CreateEntry($env:TEST_ENTRY).Open()); $writer.Write("fixture"); $writer.Dispose() } finally { $zip.Dispose() }'
    ].join('\n')], { windowsHide: true, env: { ...process.env, TEST_ARCHIVE: file, TEST_ENTRY: entry } });
  };
  const longEntry = 'jdk-fixture/' + 'long-sdk-dependency/'.repeat(9) + 'release';
  createZip(longEntry);
  const destination = path.join(directory, 'extracted');
  extractNativeArchive(archive, destination, nativeSetupEnvironment(process.env));
  assert.equal(fs.readFileSync(path.join(destination, longEntry), 'utf8'), 'fixture');
  const unsafeArchive = path.join(directory, 'unsafe.zip');
  createZip('../escaped', unsafeArchive);
  assert.throws(() => extractNativeArchive(unsafeArchive, path.join(directory, 'unsafe'), process.env), /escapes/);
  assert.equal(fs.existsSync(path.join(directory, 'escaped')), false);
});

test('local tool versions stay aligned with the protected workflow pins', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/native-build.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("ANDROID_BUILD_TOOLS_VERSION: '" + NATIVE_TOOLCHAIN.buildTools + "'"));
  assert.ok(workflow.includes("BUNDLETOOL_VERSION: '" + NATIVE_TOOLCHAIN.bundletool + "'"));
  assert.ok(workflow.includes('BUNDLETOOL_SHA256: ' + NATIVE_TOOL_DOWNLOADS.bundletool.sha256));
});
