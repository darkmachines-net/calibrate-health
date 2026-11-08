/** @file Native provider route boundaries: availability, input validation, legal consent and guarded mobile-session issuance. */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { SocialAuthRejected } = require('../src/services/socialAuth');
const { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } = require('../../shared/legalVersions');
const { parseMobileDevicePayload } = require('../src/services/mobileDevice');

/** Replace dependency boundaries for this isolated route suite without opening database connections. */
function replace(name, exports) {
  const path = require.resolve(name);
  const entry = new Module(path);
  entry.exports = exports;
  entry.loaded = true;
  require.cache[path] = entry;
}
const calls = [];
let reject;
let issued = { access_token: 'local-access', refresh_token: 'local-refresh' };
replace('../src/config/database', {});
replace('../src/services/firebaseAuthority', { firebaseAuthority: () => ({ authenticateSocial: async (...args) => {
  calls.push(args);
  if (reject) throw reject;
  return { userId: 7, version: 3 };
} }) });
replace('../src/services/mobileAuth', {
  parseMobileDevicePayload,
  issueVerifiedMobileAuthPayload: async args => { calls.push(args); return issued; },
  formatMobileAuthResponse: payload => payload
});
const router = require('../src/routes/auth').default;
const social = router.stack.find(layer => layer.route?.path === '/mobile/social').route.stack[0].handle;
const providers = router.stack.find(layer => layer.route?.path === '/mobile/providers').route.stack[0].handle;
const originalEnv = { ...process.env };
test.beforeEach(() => {
  process.env.AUTH_PROVIDER = 'firebase';
  process.env.FIREBASE_SOCIAL_PROVIDERS = 'google.com,apple.com';
  process.env.CALIBRATE_HOSTED_SERVICE = 'true';
  process.env.NODE_ENV = 'production';
  calls.length = 0;
  reject = null;
  issued = { access_token: 'local-access', refresh_token: 'local-refresh' };
});
test.afterEach(() => { process.env = { ...originalEnv }; });
const login = { provider: 'google.com', id_token: 'synthetic', intent: 'login', device_id: 'device', device_platform: 'android_phone' };
const registration = { ...login, intent: 'register', accept_terms: true, accept_privacy: true, terms_version: CURRENT_TERMS_VERSION, privacy_version: CURRENT_PRIVACY_VERSION };
/** Capture only the public wire response and headers. */
function response() {
  return { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(status) { this.statusCode = status; return this; }, json(body) { this.body = body; return this; } };
}
test('local deployments advertise no native providers', () => {
  process.env.AUTH_PROVIDER = 'local';
  const res = response();
  providers({}, res);
  assert.deepEqual(res.body, { providers: [] });
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('hosted registration rejects absent or outdated consent before contacting Firebase', async () => {
  for (const body of [{ ...login, intent: 'register' }, { ...registration, terms_version: 'old' }]) {
    const res = response();
    await social({ body }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.code, /^INVALID_LEGAL_/);
  }
  assert.equal(calls.length, 0);
});
test('valid registration and login issue credentials using the verified security generation', async () => {
  for (const body of [login, registration]) {
    calls.length = 0;
    const res = response();
    await social({ body }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0][1], body.intent === 'register');
    assert.equal(calls[0][2], true);
    assert.equal(calls[1].userId, 7);
    assert.equal(calls[1].credentialSecurityVersion, 3);
    assert.equal(res.body.access_token, 'local-access');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});
test('malformed, unsupported, and Wear requests never reach Firebase', async () => {
  for (const patch of [{ provider: 'password' }, { device_id: '' }, { device_platform: 'wear_os' }, { intent: 'unknown' }, { provider: 'apple.com' }]) {
    const res = response();
    await social({ body: { ...login, ...patch } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls.length, 0);
});
test('disabled providers fail before credential exchange', async () => {
  process.env.FIREBASE_SOCIAL_PROVIDERS = '';
  const res = response();
  await social({ body: login }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(calls.length, 0);
});
test('safe rejection codes reach the client; unexpected provider details do not', async () => {
  for (const [error, status, code] of [
    [new SocialAuthRejected('SOCIAL_REGISTRATION_REQUIRED'), 409, 'SOCIAL_REGISTRATION_REQUIRED'],
    [new SocialAuthRejected('SOCIAL_ACCOUNT_CONFLICT'), 409, 'SOCIAL_ACCOUNT_CONFLICT'],
    [new SocialAuthRejected(), 401, 'SOCIAL_AUTH_REJECTED'],
    [new Error('private provider detail'), 503, 'SOCIAL_AUTH_UNAVAILABLE']
  ]) {
    reject = error;
    const res = response();
    await social({ body: login }, res);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.code, code);
    assert.doesNotMatch(JSON.stringify(res.body), /private provider detail/);
  }
});
test('a security generation race cannot return a session', async () => {
  issued = null;
  const res = response();
  await social({ body: login }, res);
  assert.equal(res.statusCode, 401);
});
