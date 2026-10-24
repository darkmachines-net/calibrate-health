/** @file Regression coverage for native push config: native push defaults to disabled and requires an explicit Expo opt-in. */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  NATIVE_PUSH_MODES,
  getNativePushModeConfigurationWarning,
  resolveNativePushMode
} = require('../src/config/nativePush');

test('native push defaults to disabled and requires an explicit Expo opt-in', () => {
  assert.equal(resolveNativePushMode({}), NATIVE_PUSH_MODES.DISABLED);
  assert.equal(resolveNativePushMode({ NATIVE_PUSH_MODE: ' expo ' }), NATIVE_PUSH_MODES.EXPO);
  assert.equal(resolveNativePushMode({ NATIVE_PUSH_MODE: 'unexpected' }), NATIVE_PUSH_MODES.DISABLED);
});

test('native push reports only invalid configured modes', () => {
  assert.equal(getNativePushModeConfigurationWarning({}), null);
  assert.equal(getNativePushModeConfigurationWarning({ NATIVE_PUSH_MODE: 'disabled' }), null);
  assert.equal(getNativePushModeConfigurationWarning({ NATIVE_PUSH_MODE: 'EXPO' }), null);
  assert.match(
    getNativePushModeConfigurationWarning({ NATIVE_PUSH_MODE: 'fcm' }),
    /must be disabled or expo/
  );
});
