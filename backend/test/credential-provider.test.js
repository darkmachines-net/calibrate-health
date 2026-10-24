/** @file Regression coverage for credential provider: local compatibility works without Firebase configuration. */

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { CredentialProvider, CredentialProviderUnavailable } = require('../src/services/credentialVerification');

const identity = { provider: 'firebase', userId: 7, projectId: 'synthetic-project', uid: 'synthetic-uid', email: 'synthetic@example.invalid' };
const tokenClaims = () => ({ uid: identity.uid, aud: identity.projectId, auth_time: Math.floor(Date.now() / 1000) });
function setup(overrides = {}) {
  const calls = [];
  const options = {
    apiKey: 'synthetic-key',
    verifier: { projectId: identity.projectId, verifyIdToken: async () => tokenClaims() },
    fetch: async (url, request) => {
      calls.push({ url, request });
      return { ok: true, json: async () => ({ localId: identity.uid, idToken: 'synthetic-token', refreshToken: 'never-retain' }) };
    },
    ...overrides
  };
  return { calls, options, provider: new CredentialProvider(options) };
}

test('local compatibility works without Firebase configuration', async () => {
  const provider = new CredentialProvider();
  const local = { provider: 'local', userId: 7, passwordHash: await bcrypt.hash('synthetic-password', 10) };
  assert.equal(await provider.verify(local, 'synthetic-password'), true);
  assert.equal(await provider.verify(local, 'wrong-password'), false);
  assert.equal(await provider.verify(local, 'a'.repeat(73)), false);
  assert.equal(await provider.verify(local, '\ud83d\ude00'.repeat(19)), false);
});

test('Firebase authority receives passwords beyond the local bcrypt byte limit', async () => {
  const h = setup();
  const password = '\ud83d\ude00'.repeat(30);
  assert.equal(await h.provider.verify(identity, password), true);
  assert.equal(JSON.parse(h.calls[0].request.body).password, password);
});

test('Firebase password authentication returns only a boolean and binds verified project and UID', async () => {
  const h = setup();
  assert.equal(await h.provider.verify(identity, 'synthetic-password'), true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].request.redirect, 'error');
  assert.equal(JSON.parse(h.calls[0].request.body).returnSecureToken, true);
  for (const claims of [
    { ...tokenClaims(), uid: 'someone-else' }, { ...tokenClaims(), aud: 'wrong-project' },
    { ...tokenClaims(), auth_time: 0 }, { ...tokenClaims(), auth_time: Math.floor(Date.now() / 1000) + 120 }
  ]) {
    h.options.verifier.verifyIdToken = async () => claims;
    assert.equal(await h.provider.verify(identity, 'synthetic-password'), false);
  }
});

test('wrong configured project and missing configuration never call the network or local bcrypt fallback', async () => {
  const h = setup();
  await assert.rejects(h.provider.verify({ ...identity, projectId: 'other' }, 'synthetic-password'), CredentialProviderUnavailable);
  assert.equal(h.calls.length, 0);
  await assert.rejects(new CredentialProvider().verify(identity, 'synthetic-password'), CredentialProviderUnavailable);
});

test('enumeration-safe credential failures differ from retryable network/configuration failures', async () => {
  for (const code of ['INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'USER_DISABLED']) {
    const h = setup({ fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: code } }) }) });
    assert.equal(await h.provider.verify(identity, 'synthetic-password'), false);
  }
  for (const failure of [
    async () => { throw new Error('secret request URL'); },
    async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'secret' } }) }),
    async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'secret' } }) })
  ]) {
    await assert.rejects(setup({ fetch: failure }).provider.verify(identity, 'synthetic-password'), { message: 'Credential provider unavailable' });
  }
});

test('timeout covers hanging transport and token verification', async () => {
  const never = () => new Promise(() => {});
  await assert.rejects(setup({ timeoutMs: 10, fetch: never }).provider.verify(identity, 'synthetic-password'), CredentialProviderUnavailable);
  const h = setup({ timeoutMs: 10 });
  h.options.verifier.verifyIdToken = never;
  await assert.rejects(h.provider.verify(identity, 'synthetic-password'), CredentialProviderUnavailable);
});

test('forged response and verifier rejection cannot create an authenticated result', async () => {
  const h = setup();
  h.options.verifier.verifyIdToken = async () => { throw new Error('revoked token'); };
  await assert.rejects(h.provider.verify(identity, 'synthetic-password'), CredentialProviderUnavailable);
  const wrong = setup({ fetch: async () => ({ ok: true, json: async () => ({ localId: 'wrong', idToken: 'forged' }) }) });
  assert.equal(await wrong.provider.verify(identity, 'synthetic-password'), false);
});

test('runtime local verification keeps unknown accounts invalid without issuing an authenticated result', async () => {
  const { verifyLocalPassword } = require('../src/services/credentialVerification');
  assert.equal(await verifyLocalPassword('synthetic-password', undefined), false);
  assert.equal(await verifyLocalPassword('synthetic-password', ''), false);
  const password = '\u00e9'.repeat(36);
  const hash = await bcrypt.hash(password, 10);
  assert.equal(await verifyLocalPassword(password, hash), true);
  // Raw comparison preserves existing reauthentication; input limits remain caller-owned.
  assert.equal(await verifyLocalPassword(password + 'x', hash), true);
  assert.equal(await new CredentialProvider().verify({ provider: 'local', userId: 1, passwordHash: hash }, password + 'x'), false);
});

test('preparation compatibility export shares the runtime implementation and error identity', () => {
  const preparation = require('../scripts/lib/credentialProvider');
  assert.equal(preparation.CredentialProvider, CredentialProvider);
  assert.equal(preparation.CredentialProviderUnavailable, CredentialProviderUnavailable);
});

test('incomplete trusted Firebase mappings are held before any provider request', async () => {
  const h = setup();
  for (const changed of [{ userId: 0 }, { userId: NaN }, { uid: '' }, { projectId: '' }, { email: '' }]) {
    await assert.rejects(h.provider.verify({ ...identity, ...changed }, 'synthetic-password'), CredentialProviderUnavailable);
  }
  assert.equal(h.calls.length, 0);
});

test('unknown local credentials perform a dummy comparison but cannot authenticate', async () => {
  const { verifyLocalPassword } = require('../src/services/credentialVerification');
  const { DUMMY_AUTH_PASSWORD_HASH } = require('../src/utils/authCredentials');
  const original = bcrypt.compare;
  const calls = [];
  bcrypt.compare = async (...args) => { calls.push(args); return true; };
  try {
    assert.equal(await verifyLocalPassword('unknown-password', undefined), false);
    assert.deepEqual(calls, [['unknown-password', DUMMY_AUTH_PASSWORD_HASH]]);
  } finally { bcrypt.compare = original; }
});
