/** @file Regression coverage for native config: configure accepts an optional Play file and rejects manual signing-file options. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { runNative } from './native.mjs';
import { downloadEasCredentials, EAS_PLAY_CREDENTIAL_FILE } from './native-eas-credentials.mjs';
import { configureNative, nativeConfigurationPath, parseNativeConfigureArguments,
  readNativeConfiguration, resolveNativeCredentialFile } from './native-config.mjs';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-native-config-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'checkout');
  const userDirectory = path.join(temporary, 'user settings');
  fs.mkdirSync(path.join(root, 'mobile'), { recursive: true });
  fs.mkdirSync(userDirectory);
  const app = { expo: { name: 'Calibrate', owner: 'calibrate-health', slug: 'calibrate-health-app',
    android: { package: 'net.darkmachines.healthtracker' },
    extra: { eas: { projectId: 'fda8f8c5-e646-47ac-82fb-35003c9cbec7' } }, plugins: ['must-not-run'] } };
  fs.writeFileSync(path.join(root, 'mobile/app.json'), JSON.stringify(app));
  const serviceAccountFile = path.join(temporary, 'play data.json');
  const signing = { keystorePath: 'credentials/android/keystore.jks',
    keystorePassword: 'private-store-sentinel', keyAlias: 'upload', keyPassword: 'private-key-sentinel' };
  const account = { type: 'service_account', client_email: 'test@example.test', private_key: privateKey };
  fs.writeFileSync(serviceAccountFile, JSON.stringify(account));
  const calls = [];
  const options = {
    root, platform: 'win32', environment: { LOCALAPPDATA: userDirectory, EXPO_TOKEN: 'expo-sentinel',
      CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD: 'signing-sentinel', GOOGLE_APPLICATION_CREDENTIALS: 'play-sentinel' },
    log: () => {},
    ensureEas: (_root, _npm, environment) => { calls.push(['ensure', environment]); },
    runEasDownload: (_root, directory, environment, downloadPlay) => {
      calls.push(['download', directory, environment, downloadPlay]);
      const keystore = path.resolve(directory, signing.keystorePath);
      fs.mkdirSync(path.dirname(keystore), { recursive: true });
      fs.writeFileSync(keystore, 'fixture keystore');
      fs.writeFileSync(path.join(directory, 'credentials.json'), JSON.stringify({ android: { keystore: signing } }));
      if (downloadPlay) fs.writeFileSync(path.join(directory, EAS_PLAY_CREDENTIAL_FILE), JSON.stringify(account));
      return { playDownloaded: downloadPlay };
    },
    runEas: (_root, args, directory, environment) => {
      calls.push([args, directory, environment]);
    }
  };
  return { temporary, root, userDirectory, serviceAccountFile, signing, account, app, calls, options };
}

test('configure accepts an optional Play file and rejects manual signing-file options', () => {
  assert.deepEqual(parseNativeConfigureArguments([]), {});
  assert.deepEqual(parseNativeConfigureArguments(['--service-account-file', 'play.json']), { serviceAccountFile: 'play.json' });
  for (const args of [
    ['--credentials-file', 'signing.json'], ['--service-account-file'],
    ['--service-account-file', 'a', '--service-account-file', 'b'], ['constructor', 'a'], ['--', 'service-account-file', 'a']
  ]) assert.throws(() => parseNativeConfigureArguments(args));
  assert.throws(() => nativeConfigurationPath({ LOCALAPPDATA: 'relative' }, 'win32'), /absolute/);
  assert.throws(() => nativeConfigurationPath({}, 'win32'), /LOCALAPPDATA/);
});

test('configure sets up the exact app and downloads automatically without opening the credential menu', (t) => {
  const f = fixture(t);
  const result = configureNative({ serviceAccountFile: f.serviceAccountFile }, f.options);
  assert.deepEqual(f.calls[1][0], ['credentials:configure-build', '--platform', 'android', '--profile', 'internal']);
  assert.equal(f.calls[2][0], 'download');
  assert.equal(f.calls[2][3], false);
  assert.equal(f.calls.length, 3);
  const directory = path.dirname(result.credentialsFile);
  assert.equal(f.calls[1][1], directory);
  assert.equal(f.calls[2][1], directory);
  const project = JSON.parse(fs.readFileSync(path.join(directory, 'app.json'))).expo;
  assert.equal(project.android.package, 'net.darkmachines.healthtracker');
  assert.equal(project.extra.eas.projectId, f.app.expo.extra.eas.projectId);
  assert.equal(project.plugins, undefined);
  assert.equal(f.calls[0][1].EXPO_TOKEN, undefined);
  assert.equal(f.calls[1][2].EXPO_TOKEN, 'expo-sentinel');
  assert.equal(f.calls[1][2].EAS_PROJECT_ROOT, directory);
  for (const call of f.calls.slice(1)) {
    assert.equal(call[2].CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD, undefined);
    assert.equal(call[2].GOOGLE_APPLICATION_CREDENTIALS, undefined);
  }
  const credentials = JSON.parse(fs.readFileSync(result.credentialsFile)).android.keystore;
  assert.equal(credentials.keystorePath, path.join(directory, 'credentials/android/keystore.jks'));
  const saved = fs.readFileSync(result.configurationFile, 'utf8');
  assert.equal(saved.includes('sentinel'), false);
  assert.equal(saved.includes('PRIVATE KEY'), false);
  assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ['credentialsFile', 'schemaVersion', 'serviceAccountFile']);
  assert.equal(JSON.stringify(result).includes('sentinel'), false);
  assert.equal(fs.existsSync(path.join(f.root, 'mobile/credentials.json')), false);
});

test('configure refreshes the assigned EAS Play key and preserves previous snapshots across checkouts', (t) => {
  const f = fixture(t);
  delete f.signing.keyPassword;
  const first = configureNative({}, f.options);
  assert.equal(JSON.parse(fs.readFileSync(first.credentialsFile)).android.keystore.keyPassword, f.signing.keystorePassword);
  assert.equal(JSON.parse(fs.readFileSync(first.serviceAccountFile)).private_key, privateKey);
  assert.equal(f.calls[2][2].EXPO_TOKEN, 'expo-sentinel');
  assert.equal(f.calls[2][2].GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(f.calls[2][2].CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD, undefined);
  configureNative({ serviceAccountFile: f.serviceAccountFile }, f.options);
  const refreshed = configureNative({}, f.options);
  assert.notEqual(first.credentialsFile, refreshed.credentialsFile);
  assert.ok(fs.existsSync(first.credentialsFile));
  assert.ok(fs.existsSync(first.serviceAccountFile));
  assert.notEqual(refreshed.serviceAccountFile, first.serviceAccountFile);
  assert.notEqual(refreshed.serviceAccountFile, f.serviceAccountFile);
  assert.equal(fs.readFileSync(refreshed.configurationFile, 'utf8').includes('PRIVATE KEY'), false);
  const secondRoot = path.join(f.temporary, 'another checkout');
  fs.mkdirSync(secondRoot);
  assert.equal(resolveNativeCredentialFile('credentialsFile', undefined, { ...f.options, root: secondRoot }), refreshed.credentialsFile);
});

test('an unassigned EAS Play key configures builds and clears stale submission settings', (t) => {
  const f = fixture(t);
  const first = configureNative({}, f.options);
  const messages = [];
  const refreshed = configureNative({}, { ...f.options,
    runEasDownload: (root, directory, environment) => f.options.runEasDownload(root, directory, environment, false),
    log: (message) => messages.push(message) });
  assert.equal(refreshed.serviceAccountFile, undefined);
  assert.equal(readNativeConfiguration(f.options).config.serviceAccountFile, undefined);
  assert.match(messages.at(-1), /No Play submission key is assigned/);
  assert.ok(fs.existsSync(first.serviceAccountFile));
  assert.throws(() => resolveNativeCredentialFile('serviceAccountFile', undefined, f.options), /Assign it to the app in EAS/);
});

test('failed or invalid EAS Play downloads preserve the complete previous configuration', (t) => {
  const f = fixture(t);
  const first = configureNative({}, f.options);
  const before = fs.readFileSync(first.configurationFile, 'utf8');
  const parent = path.dirname(first.configurationFile);
  const directories = fs.readdirSync(parent);
  for (const runEasDownload of [
    () => { throw new Error('EAS unavailable'); },
    () => ({ playDownloaded: true }),
    (...args) => { const result = f.options.runEasDownload(...args); fs.writeFileSync(path.join(args[1], EAS_PLAY_CREDENTIAL_FILE), 'secret-sentinel{'); return result; },
    (...args) => { const result = f.options.runEasDownload(...args); fs.writeFileSync(path.join(args[1], EAS_PLAY_CREDENTIAL_FILE), JSON.stringify({ ...f.account, private_key: 'secret-sentinel' })); return result; }
  ]) {
    assert.throws(() => configureNative({}, { ...f.options, runEasDownload }), (error) => {
      assert.doesNotMatch(error.message, /secret-sentinel/);
      return true;
    });
    assert.equal(fs.readFileSync(first.configurationFile, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(parent), directories);
  }
});

test('invalid Play data fails before EAS authentication without changing settings or leaking secrets', (t) => {
  const f = fixture(t);
  const initial = configureNative({}, f.options);
  const before = fs.readFileSync(initial.configurationFile, 'utf8');
  f.calls.length = 0;
  for (const content of ['private-sentinel{', JSON.stringify({ ...f.account, private_key: 'private-sentinel' }),
    JSON.stringify({ ...f.account, token_uri: 'https://wrong.example/token' })]) {
    fs.writeFileSync(f.serviceAccountFile, content);
    assert.throws(() => configureNative({ serviceAccountFile: f.serviceAccountFile }, f.options), (error) => {
      assert.doesNotMatch(error.message, /private-sentinel/);
      return true;
    });
    assert.deepEqual(f.calls, []);
    assert.equal(fs.readFileSync(initial.configurationFile, 'utf8'), before);
  }
});

test('cancelled, missing, or invalid downloads preserve prior credentials and remove only the failed attempt', (t) => {
  const f = fixture(t);
  const initial = configureNative({}, f.options);
  const directory = path.dirname(initial.configurationFile);
  const before = fs.readFileSync(initial.configurationFile, 'utf8');
  const files = fs.readdirSync(directory);
  for (const override of [
    { runEas: () => { throw new Error('Cancelled'); } },
    { runEasDownload: () => ({ playDownloaded: false }) },
    ...['private-sentinel{', '{}'].map((contents) => ({ runEasDownload: (_root, output) => {
      fs.writeFileSync(path.join(output, 'credentials.json'), contents);
      return { playDownloaded: false };
    } }))
  ]) {
    assert.throws(() => configureNative({}, { ...f.options, ...override }), (error) => {
      assert.doesNotMatch(error.message, /private-sentinel/);
      return true;
    });
    assert.equal(fs.readFileSync(initial.configurationFile, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(directory), files);
    assert.ok(fs.existsSync(initial.credentialsFile));
  }
});

test('wrong EAS project or package is rejected before credential operations', (t) => {
  const f = fixture(t);
  for (const app of [
    { ...f.app.expo, android: { package: 'old.package' } },
    { ...f.app.expo, extra: { eas: { projectId: 'wrong-project' } } }
  ]) {
    fs.writeFileSync(path.join(f.root, 'mobile/app.json'), JSON.stringify({ expo: app }));
    assert.throws(() => configureNative({}, f.options), /linked Calibrate EAS project/);
    assert.deepEqual(f.calls, []);
  }
});

test('settings and downloaded keystores cannot resolve inside the checkout', (t) => {
  const f = fixture(t);
  assert.throws(() => configureNative({}, { ...f.options, environment: { LOCALAPPDATA: f.root } }), /outside the repository/);
  f.signing.keystorePath = path.join(f.root, 'invalid.jks');
  assert.throws(() => configureNative({}, f.options), /outside the repository/);
  const linkedUser = path.join(f.temporary, 'linked user');
  fs.mkdirSync(linkedUser);
  fs.symlinkSync(f.root, path.join(linkedUser, 'calibrate-health'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readNativeConfiguration({ ...f.options, environment: { LOCALAPPDATA: linkedUser } }), /outside the repository/);
});

test('corrupt settings can be replaced by syncing EAS without file arguments', (t) => {
  const f = fixture(t);
  const file = nativeConfigurationPath(f.options.environment, 'win32');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const invalid of ['secret-sentinel{', JSON.stringify({ schemaVersion: 1, credentialsFile: 'relative.json' }),
    JSON.stringify({ schemaVersion: 1, unexpectedSecret: 'secret-sentinel' })]) {
    fs.writeFileSync(file, invalid);
    assert.throws(() => readNativeConfiguration(f.options), (error) => {
      assert.match(error.message, /native:configure/);
      assert.doesNotMatch(error.message, /secret-sentinel/);
      return true;
    });
  }
  const result = configureNative({}, f.options);
  assert.equal(readNativeConfiguration(f.options).config.credentialsFile, result.credentialsFile);
});

test('build resolves the EAS path without reading signing contents or the Play credential', (t) => {
  const f = fixture(t);
  const result = configureNative({ serviceAccountFile: f.serviceAccountFile }, f.options);
  fs.rmSync(f.serviceAccountFile);
  fs.writeFileSync(result.credentialsFile, 'not parsed until after credential-free prebuild');
  assert.equal(resolveNativeCredentialFile('credentialsFile', undefined, f.options), result.credentialsFile);
  assert.throws(() => resolveNativeCredentialFile('serviceAccountFile', undefined, f.options), /existing external file/);
  const override = path.join(f.temporary, 'override.json');
  fs.writeFileSync(override, 'metadata only');
  assert.equal(resolveNativeCredentialFile('credentialsFile', override, f.options), fs.realpathSync(override));
  assert.equal(readNativeConfiguration(f.options).config.credentialsFile, result.credentialsFile);
});

test('EAS configure, setup, bare build and submit compose without repeated file arguments', async (t) => {
  const f = fixture(t);
  const events = [];
  const options = { ...f.options, readUserEnvironment: () => ({}),
    configure: (values, request) => configureNative(values, { ...f.options, ...request }),
    setup: () => events.push('setup'),
    internal: (args, { environment }) => {
      assert.equal(environment.EXPO_TOKEN, undefined);
      assert.equal(environment.CALIBRATE_ANDROID_SIGNING_STORE_PASSWORD, undefined);
      events.push(args);
    }
  };
  const configured = await runNative(['configure'], options);
  await runNative(['setup'], options);
  await runNative(['build'], options);
  await runNative(['submit'], options);
  assert.deepEqual(events, ['setup', ['build', '--credentials-file', configured.credentialsFile],
    ['submit', '--service-account-file', configured.serviceAccountFile, '--confirm-play-console-clean']]);
});

function easResponse(f, assigned = { keyJson: JSON.stringify(f.account) }) {
  return { data: { app: { byId: { id: f.app.expo.extra.eas.projectId, androidAppCredentials: [{
    applicationIdentifier: f.app.expo.android.package, googleServiceAccountKeyForSubmissions: assigned,
    androidAppBuildCredentialsList: [{ isDefault: true, androidKeystore: {
      keystore: Buffer.from('fixture keystore').toString('base64'), keystorePassword: f.signing.keystorePassword,
      keyAlias: f.signing.keyAlias, keyPassword: f.signing.keyPassword
    } }]
  }] } } } };
}

function stagingDirectory(f) {
  const directory = fs.mkdtempSync(path.join(f.userDirectory, 'eas-android-'));
  fs.writeFileSync(path.join(directory, 'app.json'), JSON.stringify(f.app));
  return directory;
}

test('EAS downloads the default keystore and assigned Play key for the exact app into external files', async (t) => {
  const f = fixture(t);
  const directory = stagingDirectory(f);
  const response = easResponse(f);
  response.data.app.byId.androidAppCredentials[0].androidAppBuildCredentialsList.unshift({ isDefault: false, androidKeystore: {} });
  const result = await downloadEasCredentials({ root: f.root, directory, query: async (document, variables) => {
    assert.deepEqual(variables, { projectId: f.app.expo.extra.eas.projectId, applicationIdentifier: f.app.expo.android.package, downloadPlay: true });
    assert.match(document, /googleServiceAccountKeyForSubmissions/);
    assert.match(document, /androidAppBuildCredentialsList/);
    assert.doesNotMatch(document, /googleServiceAccountKeyForFcmV1/);
    return response;
  } });
  assert.deepEqual(result, { playDownloaded: true });
  const file = path.join(directory, EAS_PLAY_CREDENTIAL_FILE);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), f.account);
  const signing = JSON.parse(fs.readFileSync(path.join(directory, 'credentials.json'))).android.keystore;
  assert.equal(signing.keyAlias, f.signing.keyAlias);
  assert.equal(signing.keystorePath, path.join(directory, 'credentials/android/keystore.jks'));
  assert.equal(fs.readFileSync(signing.keystorePath, 'utf8'), 'fixture keystore');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await assert.rejects(downloadEasCredentials({ root: f.root, directory, query: async () => easResponse(f) }), /EEXIST/);
});

test('EAS download handles no assigned Play key without choosing an unrelated key', async (t) => {
  const f = fixture(t);
  const directory = stagingDirectory(f);
  const response = easResponse(f, null);
  response.data.app.byId.androidAppCredentials[0].googleServiceAccountKeyForFcmV1 = { keyJson: JSON.stringify(f.account) };
  assert.deepEqual(await downloadEasCredentials({ root: f.root, directory, query: async () => response }), { playDownloaded: false });
  assert.ok(fs.existsSync(path.join(directory, 'credentials.json')));
  assert.equal(fs.existsSync(path.join(directory, EAS_PLAY_CREDENTIAL_FILE)), false);
});

test('EAS download rejects wrong identities, ambiguous responses, API errors, and invalid secrets without disclosure', async (t) => {
  const f = fixture(t);
  const directory = stagingDirectory(f);
  const wrongProject = easResponse(f);
  wrongProject.data.app.byId.id = 'wrong-project';
  const wrongApp = easResponse(f);
  wrongApp.data.app.byId.androidAppCredentials[0].applicationIdentifier = 'wrong.app';
  const ambiguous = easResponse(f);
  ambiguous.data.app.byId.androidAppCredentials.push(ambiguous.data.app.byId.androidAppCredentials[0]);
  for (const response of [wrongProject, wrongApp, ambiguous, {}, { error: new Error('private-sentinel') },
    easResponse(f, {}), easResponse(f, { keyJson: 'private-sentinel{' }),
    easResponse(f, { keyJson: JSON.stringify({ ...f.account, token_uri: 'https://private-sentinel/token' }) }),
    easResponse(f, { keyJson: JSON.stringify({ ...f.account, private_key: 'private-sentinel' }) })]) {
    await assert.rejects(downloadEasCredentials({ root: f.root, directory, query: async () => response }), (error) => {
      assert.doesNotMatch(error.message, /private-sentinel/);
      return true;
    });
    assert.equal(fs.existsSync(path.join(directory, EAS_PLAY_CREDENTIAL_FILE)), false);
    assert.equal(fs.existsSync(path.join(directory, 'credentials.json')), false);
  }
  await assert.rejects(downloadEasCredentials({ root: f.root, directory, query: async () => { throw new Error('private-sentinel'); } }), /lookup failed/);
});

test('EAS skips the Play secret for a local override and defaults a missing key password', async (t) => {
  const f = fixture(t);
  const directory = stagingDirectory(f);
  const response = easResponse(f, { keyJson: 'must not read this invalid key' });
  response.data.app.byId.androidAppCredentials[0].androidAppBuildCredentialsList[0].androidKeystore.keyPassword = null;
  const result = await downloadEasCredentials({ root: f.root, directory, downloadPlay: false, query: async (document, variables) => {
    assert.equal(variables.downloadPlay, false);
    assert.match(document, /googleServiceAccountKeyForSubmissions @include\(if: \$downloadPlay\)/);
    return response;
  } });
  assert.deepEqual(result, { playDownloaded: false });
  assert.equal(fs.existsSync(path.join(directory, EAS_PLAY_CREDENTIAL_FILE)), false);
  const signing = JSON.parse(fs.readFileSync(path.join(directory, 'credentials.json'))).android.keystore;
  assert.equal(signing.keyPassword, f.signing.keystorePassword);
});

test('EAS requires a single default keystore and rejects malformed signing data before writing credentials', async (t) => {
  const f = fixture(t);
  const directory = stagingDirectory(f);
  const valid = easResponse(f).data.app.byId.androidAppCredentials[0].androidAppBuildCredentialsList[0];
  for (const builds of [undefined, [], [{ ...valid, isDefault: false }], [valid, valid], [{ isDefault: true, androidKeystore: null }],
    ...[{ keystore: '' }, { keystore: 'private-sentinel!' }, { keyAlias: null }, { keystorePassword: null }, { keyPassword: '' }]
      .map((invalid) => [{ ...valid, androidKeystore: { ...valid.androidKeystore, ...invalid } }])]) {
    const response = easResponse(f);
    response.data.app.byId.androidAppCredentials[0].androidAppBuildCredentialsList = builds;
    await assert.rejects(downloadEasCredentials({ root: f.root, directory, query: async () => response }), (error) => {
      assert.doesNotMatch(error.message, /private-sentinel/);
      return true;
    });
    assert.equal(fs.existsSync(path.join(directory, 'credentials.json')), false);
    assert.equal(fs.existsSync(path.join(directory, EAS_PLAY_CREDENTIAL_FILE)), false);
  }
});
