/** @file Final AAB manifests must use the new explicit major runtime and expected EAS destination. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBundleRuntime, parseBundleResourceValue } from './native-runtime-checks.mjs';
const expected = { role: 'phone', projectId: 'project', runtime: '1', channel: 'production' };
const xml = '<application android:usesCleartextTraffic="false">' +
  '<meta-data android:name="expo.modules.updates.EXPO_UPDATE_URL" android:value="https://u.expo.dev/project"/>' +
  '<meta-data android:name="expo.modules.updates.EXPO_RUNTIME_VERSION" android:value="1"/>' +
  '<meta-data android:name="expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY" android:value="{&quot;expo-channel-name&quot;:&quot;production&quot;}"/>' +
  '</application>';

test('explicit major runtimes and resolved Android string resources are accepted', () => {
  assert.doesNotThrow(() => validateBundleRuntime(xml, expected));
  assert.doesNotThrow(() => validateBundleRuntime(xml.replace('android:value="1"', 'android:value="@string/runtime"'), expected, () => '1'));
  assert.equal(parseBundleResourceValue(' - [STR] "1"\n - [STR] "1"'), '1');
  assert.throws(() => parseBundleResourceValue(' - [STR] "1"\n - [STR] "2"'), /consistent/);
});

test('legacy runtimes, wrong destinations and unsafe release manifests are rejected', () => {
  for (const changed of [xml.replace('android:value="1"', 'android:value="file:fingerprint"'),
    xml.replace('android:value="1"', 'android:value="2"'), xml.replace('/project', '/other'),
    xml.replace('production', 'internal'), xml.replace('usesCleartextTraffic="false"', 'usesCleartextTraffic="true"'),
    xml.replace('<application ', '<application android:debuggable="true" ')]) {
    assert.throws(() => validateBundleRuntime(changed, expected));
  }
});
