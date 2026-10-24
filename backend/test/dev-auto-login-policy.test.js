/** @file Regression coverage for dev auto login policy: devAutoLoginPolicy: shouldAutoLoginTestUser returns false when not explicitly enabled. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldAutoLoginTestUser } = require('../src/utils/devAutoLoginPolicy');

const buildReq = (opts) => ({
  path: opts.path ?? '/some/path',
  isAuthenticated: () => Boolean(opts.isAuthenticated)
});

test('devAutoLoginPolicy: shouldAutoLoginTestUser returns false when not explicitly enabled', () => {
  const req = buildReq({ isAuthenticated: false });
  assert.equal(shouldAutoLoginTestUser(req, { NODE_ENV: 'development' }), false);
  assert.equal(shouldAutoLoginTestUser(req, { AUTO_LOGIN_TEST_USER: 'false' }), false);
});

test('devAutoLoginPolicy: shouldAutoLoginTestUser blocks auto-login in production/staging envs', () => {
  const req = buildReq({ isAuthenticated: false });
  assert.equal(shouldAutoLoginTestUser(req, { AUTO_LOGIN_TEST_USER: 'true', NODE_ENV: 'production' }), false);
  assert.equal(shouldAutoLoginTestUser(req, { AUTO_LOGIN_TEST_USER: 'true', NODE_ENV: 'staging' }), false);
});

test('devAutoLoginPolicy: shouldAutoLoginTestUser blocks auto-login when already authenticated', () => {
  const req = buildReq({ isAuthenticated: true });
  assert.equal(shouldAutoLoginTestUser(req, { AUTO_LOGIN_TEST_USER: 'true', NODE_ENV: 'development' }), false);
});

test('devAutoLoginPolicy: shouldAutoLoginTestUser blocks auto-login on logout requests', () => {
  const req = buildReq({ path: '/auth/logout', isAuthenticated: false });
  assert.equal(shouldAutoLoginTestUser(req, { AUTO_LOGIN_TEST_USER: 'true', NODE_ENV: 'development' }), false);
});

test('devAutoLoginPolicy: shouldAutoLoginTestUser enables auto-login only for unauthenticated non-logout dev requests', () => {
  const req = buildReq({ path: '/metrics/today', isAuthenticated: false });
  assert.equal(shouldAutoLoginTestUser(req, { AUTO_LOGIN_TEST_USER: 'true', NODE_ENV: 'development' }), true);
});
