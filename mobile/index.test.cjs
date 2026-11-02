/** @file Execute the real entry and shared gate with native stubs to prove incompatible clients never load Router. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

/** Run registration without a device; only native primitives are available until the gate admits Router. */
function start({ platform = 'android', client = true, installed = 'current', required = 'current' } = {}) {
  const loaded = [], registered = [], root = () => null;
  const native = {
    Platform: { OS: platform },
    NativeModules: client ? { EXDevLauncher: { manifestString: JSON.stringify({ runtimeVersion: required }) } } : {},
    AppRegistry: { registerComponent: (name, load) => registered.push([name, load()]) },
  };
  const gate = { exports: {} };
  const requireStub = name => {
    loaded.push(name);
    if (name === 'react-native') return native;
    if (name === 'expo-modules-core') return { requireOptionalNativeModule: () => ({ runtimeVersion: installed }) };
    if (name === 'react') return { createElement: () => null };
    if (name === 'expo') return { registerRootComponent: component => registered.push(['main', component]) };
    if (name === '@mchartier/expo-release/register') return gate.exports;
    if (name === 'expo-router/build/qualified-entry') return { App: root };
    if (['@expo/metro-runtime', 'expo-router/entry'].includes(name)) return {};
    throw new Error(`Unexpected startup import: ${name}`);
  };
  const context = { require: requireStub, module: gate, console: { warn() {} } };
  vm.runInNewContext(fs.readFileSync(require.resolve('@mchartier/expo-release/register'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'), { ...context });
  return { loaded, registered, root };
}

test('matching Android and iOS clients load Router only after reading native runtime', () => {
  for (const platform of ['android', 'ios']) {
    const { loaded, registered, root } = start({ platform });
    assert.ok(loaded.indexOf('expo-modules-core') < loaded.indexOf('expo-router/build/qualified-entry'));
    assert.deepEqual(registered, [['main', root]]);
    assert.ok(!loaded.includes('expo-router/entry'));
  }
});

test('mismatched or unavailable runtimes show recovery without evaluating application imports', () => {
  for (const runtime of [{ installed: 'old' }, { installed: null }, { required: null }]) {
    const { loaded, registered } = start(runtime);
    assert.ok(!loaded.some(name => name.startsWith('expo-router')));
    assert.equal(registered[0][1].name, 'IncompatibleClient');
  }
});

test('web, Expo Go and release builds keep the normal Expo Router entry', () => {
  for (const runtime of [{ platform: 'web' }, { client: false }]) {
    const { loaded } = start(runtime);
    assert.ok(loaded.includes('expo-router/entry'));
    assert.ok(!loaded.includes('expo-modules-core'));
  }
});
