/** @file Regression coverage for native internal release: CLI accepts only command-specific internal options and requires Console coordination. */

/** Exercise local paired builds, internal-track plans, and private-runtime artifact verification. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildLocalInternalRelease, configureLocalInternalToolchain, createLocalInternalPlan, inspectWindowsCmake, INTERNAL_CHANNEL, INTERNAL_PROJECT_ID,
  INTERNAL_SERVER_URL, LOCAL_RECORD_PATH, loadLocalSigningEnvironment, localInternalEnvironment,
  parseBundleResourceValue, parseLocalInternalArgs, requireExternalFile, validateInternalBundleManifest,
  validateLocalInternalBaseline, verifyLocalRecord, verifyLocalInternalArtifacts
} from './native-internal-release.mjs';

const COMMIT = 'a'.repeat(40);
/** Allocate an isolated local build plan with known native version codes. */
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-local-internal-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repository');
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shared/release.json'), JSON.stringify({
    android: {
      application_id: 'net.darkmachines.healthtracker',
      mobile: { version_name: '0.2.7', version_code: 11, native_release_tag: 'native-v0.2.7' },
      wear: { version_name: '0.2.7', version_code: 12 }
    }
  }));
  const plan = createLocalInternalPlan(root, COMMIT);
  const baseline = {
    commit: COMMIT, platform: 'android', server_url: INTERNAL_SERVER_URL,
    channel: INTERNAL_CHANNEL, project_id: INTERNAL_PROJECT_ID, runtime_version: '0.2.7'
  };
  return { root, temporary, plan, baseline };
}

test('CLI accepts only command-specific internal options and requires Console coordination', () => {
  assert.deepEqual(parseLocalInternalArgs(['prepare', '--bump', 'patch']), { command: 'prepare', values: { '--bump': 'patch' } });
  for (const argv of [
    ['promote-production'], ['submit', '--track', 'production'],
    ['build', '--credentials-file', 'a', '--credentials-file', 'b'],
    ['doctor', '--service-account-file', 'secret.json'], ['build', '--credentials-file']
  ]) assert.throws(() => parseLocalInternalArgs(argv));
  assert.throws(() => parseLocalInternalArgs(['submit', '--service-account-file', 'a']), /Publishing overview/);
  assert.equal(parseLocalInternalArgs(['submit', '--service-account-file', 'a', '--confirm-play-console-clean']).command, 'submit');
});

test('local build pins private origin, project and channel and removes Play authentication', () => {
  const env = localInternalEnvironment({
    EXPO_PUBLIC_CALIBRATE_SERVER_URL: 'https://wrong.example', EXPO_UPDATES_CHANNEL: 'production',
    EXPO_PUBLIC_EAS_PROJECT_ID: 'wrong', GOOGLE_PLAY_ACCESS_TOKEN: 'secret',
    google_application_credentials: 'secret-file', PATH: 'tools'
  });
  assert.equal(env.EXPO_PUBLIC_CALIBRATE_SERVER_URL, INTERNAL_SERVER_URL);
  assert.equal(env.EXPO_PUBLIC_EAS_PROJECT_ID, INTERNAL_PROJECT_ID);
  assert.equal(env.EXPO_UPDATES_CHANNEL, INTERNAL_CHANNEL);
  assert.equal(env.PATH, 'tools');
  assert.equal(Object.keys(env).some((key) => key.toUpperCase().startsWith('GOOGLE_')), false);
});

test('external Expo keystore config maps to shared signing without logging or accepting checkout secrets', (t) => {
  const { root, temporary } = fixture(t);
  const store = path.join(temporary, 'upload.p12');
  const file = path.join(temporary, 'credentials.json');
  fs.writeFileSync(store, 'keystore');
  const credentials = { android: { keystore: {
    keystorePath: store, keystorePassword: 'private-store-password', keyAlias: 'upload', keyPassword: 'private-key-password'
  } } };
  fs.writeFileSync(file, JSON.stringify(credentials));
  const result = loadLocalSigningEnvironment(root, file, { PATH: 'tools' });
  assert.equal(result.CALIBRATE_ANDROID_SIGNING_STORE_FILE, fs.realpathSync(store));
  assert.equal(result.CALIBRATE_ANDROID_SIGNING_KEY_ALIAS, 'upload');
  assert.equal(result.PATH, 'tools');
  const internal = path.join(root, 'credentials.json');
  fs.copyFileSync(file, internal);
  assert.throws(() => requireExternalFile(root, internal, 'credentials'), /outside the repository/);
  credentials.android.keystore.keystorePath = 'relative.p12';
  fs.writeFileSync(file, JSON.stringify(credentials));
  assert.throws(() => loadLocalSigningEnvironment(root, file, {}), /absolute keystorePath/);
});

test('local plan markers cannot be confused with protected GitHub release names', (t) => {
  const { plan } = fixture(t);
  assert.equal(plan.candidates.phone.releaseName, `local-p@${COMMIT}`);
  assert.equal(plan.candidates.watch.releaseName, `local-w@${COMMIT}`);
  assert.equal(plan.candidates.phone.internalTrack, 'internal');
  assert.equal(plan.candidates.watch.internalTrack, 'wear:internal');
});

test('private baseline rejects a stale commit, server, project, channel or native runtime', (t) => {
  const { plan, baseline } = fixture(t);
  validateLocalInternalBaseline(baseline, plan);
  for (const key of ['commit', 'server_url', 'channel', 'project_id', 'runtime_version', 'platform']) {
    assert.throws(() => validateLocalInternalBaseline({ ...baseline, [key]: 'wrong' }, plan), /Rebuild/);
  }
});

/** Model final Android manifest entries used to verify private builds. */
function phoneManifest(runtime = '0.2.7') {
  return `<manifest><application android:usesCleartextTraffic="false">
    <meta-data android:name="expo.modules.updates.EXPO_UPDATE_URL" android:value="https://u.expo.dev/${INTERNAL_PROJECT_ID}"/>
    <meta-data android:name="expo.modules.updates.EXPO_RUNTIME_VERSION" android:value="${runtime}"/>
    <meta-data android:name="expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY" android:value="{&quot;expo-channel-name&quot;:&quot;internal&quot;}"/>
  </application></manifest>`;
}

test('final bundle configuration rejects cleartext, debug mode and wrong Expo identity', () => {
  const xml = phoneManifest();
  validateInternalBundleManifest(xml, 'phone', '0.2.7');
  validateInternalBundleManifest(phoneManifest('@string/expo_runtime_version'), 'phone', '0.2.7', (key) => {
    assert.equal(key, 'string/expo_runtime_version');
    return '0.2.7';
  });
  for (const changed of [
    xml.replace('usesCleartextTraffic="false"', 'usesCleartextTraffic="true"'),
    xml.replace('<application ', '<application android:debuggable="true" '),
    xml.replace('internal', 'production'), xml.replace('0.2.7', '0.2.6'),
    xml.replace(INTERNAL_PROJECT_ID, 'wrong-project')
  ]) assert.throws(() => validateInternalBundleManifest(changed, 'phone', '0.2.7'));
  assert.throws(() => validateInternalBundleManifest('<application/>', 'watch', '0.2.7'), /HTTPS-only/);
});

test('build admits signing only after preparation and verifies without signing/Play secrets', async (t) => {
  const { root, baseline } = fixture(t);
  const order = [];
  const result = await buildLocalInternalRelease({ root, credentialsFile: 'external.json', environment: {} }, {
    readSource: () => COMMIT,
    runStage: (_root, stage, env) => {
      order.push(stage);
      assert.equal(env.EXPO_PUBLIC_CALIBRATE_SERVER_URL, INTERNAL_SERVER_URL);
      if (stage === 'prepare') assert.equal(env.CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD, undefined);
      else assert.equal(env.CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD, 'password');
    },
    configureToolchain: () => order.push('toolchain'),
    loadSigning: (_root, _file, env) => {
      order.push('credentials');
      return { ...env, CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD: 'password' };
    },
    verifyArtifacts: ({ environment }) => {
      order.push('verify');
      assert.equal(environment.CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD, undefined);
      return { artifacts: ['inspected'] };
    },
    readBaseline: () => ({ baseline }), tooling: {}, inspectConfiguration: () => ({ inspected: true })
  });
  assert.deepEqual(order, ['prepare', 'toolchain', 'credentials', 'build-prepared', 'verify']);
  assert.equal(result.provenance, 'local-internal');
  const record = JSON.parse(fs.readFileSync(path.join(root, LOCAL_RECORD_PATH), 'utf8'));
  verifyLocalRecord(root, record);
  assert.equal(JSON.stringify(record).includes('password'), false);
  assert.throws(() => verifyLocalRecord(root, { ...record, provenance: 'github-attested' }), /changed/);
});

test('failed preparation never reads signing and invalidates any previous local evidence', async (t) => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(path.join(root, LOCAL_RECORD_PATH), 'old evidence');
  await assert.rejects(buildLocalInternalRelease({ root, credentialsFile: 'external.json', environment: {} }, {
    readSource: () => COMMIT,
    runStage: () => { throw new Error('prebuild failed'); },
    loadSigning: () => assert.fail('must not read credentials')
  }), /prebuild failed/);
  assert.equal(fs.existsSync(path.join(root, LOCAL_RECORD_PATH)), false);
});

test('retained local artifacts must match clean source, actual metadata, and recorded hashes before reuse', async (t) => {
  const { root, baseline } = fixture(t);
  let source = COMMIT;
  let verification = { artifacts: [{ sha256: 'a'.repeat(64) }] };
  const dependencies = {
    checkConfiguration: async () => {},
    readSource: () => source,
    runStage: () => {}, configureToolchain: () => {}, loadSigning: (_root, _file, env) => env,
    verifyArtifacts: () => verification, readBaseline: () => ({ baseline }),
    tooling: {}, inspectConfiguration: () => ({ inspected: true })
  };
  const request = { root, environment: {}, credentialsFile: 'external.json' };
  await buildLocalInternalRelease(request, dependencies);
  assert.equal((await verifyLocalInternalArtifacts(request, dependencies)).plan.sourceCommit, COMMIT);
  verification = { artifacts: [{ sha256: 'b'.repeat(64) }] };
  await assert.rejects(verifyLocalInternalArtifacts(request, dependencies), /artifacts or build configuration changed/);
  source = 'b'.repeat(40);
  await assert.rejects(verifyLocalInternalArtifacts(request, dependencies), /baseline must match/);
  dependencies.readSource = () => { throw new Error('Dirty checkout'); };
  await assert.rejects(verifyLocalInternalArtifacts(request, dependencies), /Dirty checkout/);
});

test('an already-admitted signing environment cannot enter preparation', async (t) => {
  const { root } = fixture(t);
  await assert.rejects(buildLocalInternalRelease({ root, credentialsFile: 'external.json', environment: {
    CALIBRATE_ANDROID_SIGNING_KEY_PASSWORD: 'secret'
  } }, { readSource: () => COMMIT, runStage: () => assert.fail('no prebuild') }), /rejects admitted/);
});


test('bundletool resource strings resolve all configurations and reject conflicting values', () => {
  const dump = 'Package net.darkmachines.healthtracker:\n0x7f001 - string/expo_runtime_version\n\t(default) - [STR] "0.2.7"\n';
  assert.equal(parseBundleResourceValue(dump), '0.2.7');
  assert.throws(() => parseBundleResourceValue(dump + '\tlocale - [STR] "0.2.6"'), /consistent/);
  assert.throws(() => parseBundleResourceValue('resource missing'), /consistent/);
  validateInternalBundleManifest(phoneManifest('0x7f001'), 'phone', '0.2.7', (key) => {
    assert.equal(key, '0x7f001');
    return parseBundleResourceValue(dump);
  });
});


test('Windows prebuild selects current CMake without retaining an older host override', (t) => {
  const { root, temporary } = fixture(t);
  const directory = path.join(root, 'mobile/android');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'local.properties');
  fs.writeFileSync(file, 'sdk.dir=C:/Android/Sdk\ncmake.dir=C:/old\n');
  const tooling = { sdkRoot: path.join(temporary, 'SDK') };
  const execute = (command) => command.endsWith('cmake.exe') ? 'cmake version 3.31.6' : '1.12.1';
  configureLocalInternalToolchain(root, {}, { platform: 'win32', tooling, execute });
  const configured = fs.readFileSync(file, 'utf8');
  assert.match(configured, /sdk.dir=C:\/Android\/Sdk/);
  assert.match(configured, /cmake.dir=.*SDK\/cmake\/3.31.6/);
  assert.equal(configured.includes('C:/old'), false);
  assert.throws(() => inspectWindowsCmake(tooling, {}, (command) =>
    command.endsWith('cmake.exe') ? 'cmake version 3.31.6' : '1.10.2'), /Ninja 1.12/);
  assert.throws(() => inspectWindowsCmake(tooling, {}, () => 'cmake version 3.22.1'), /CMake 3.31.6/);
});
