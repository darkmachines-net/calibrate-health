/** @file Regression coverage for config credential provider: existing local installations remain local even when unrelated Firebase environment values exist. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCredentialProviderConfiguration } = require('../src/config/credentialProvider');

test('existing local installations remain local even when unrelated Firebase environment values exist', () => {
  assert.doesNotThrow(() => validateCredentialProviderConfiguration({}));
  assert.doesNotThrow(() => validateCredentialProviderConfiguration({ AUTH_PROVIDER: ' LOCAL ' }));
  assert.doesNotThrow(() => validateCredentialProviderConfiguration({ FIREBASE_PROJECT_ID: 'synthetic-project' }));
});

test('incomplete provider activation fails closed instead of silently using local credentials', () => {
  for (const AUTH_PROVIDER of ['firebase', 'typo']) {
    assert.throws(() => validateCredentialProviderConfiguration({ AUTH_PROVIDER }), /must remain local/);
  }
});
