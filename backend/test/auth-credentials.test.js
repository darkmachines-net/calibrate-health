/** @file Regression coverage for auth credentials: password credentials reject bcrypt-truncated UTF-8 values. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_AUTH_PASSWORD_BYTES,
  validateBcryptPasswordByteLength,
  validatePasswordCredential
} = require('../src/utils/authCredentials');

test('password credentials reject bcrypt-truncated UTF-8 values', () => {
  assert.equal(MAX_AUTH_PASSWORD_BYTES, 72);
  assert.equal(validatePasswordCredential('a'.repeat(72)), null);
  assert.equal(validatePasswordCredential('\ud83d\ude00'.repeat(18)), null);
  assert.equal(
    validateBcryptPasswordByteLength('\ud83d\ude00'.repeat(19), 'Current password'),
    'Current password must be at most 72 bytes'
  );
});
