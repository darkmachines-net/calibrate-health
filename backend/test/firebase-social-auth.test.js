/** @file Synthetic provider exchange tests covering UID binding, consent boundaries, token validation and safe failures. */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const databasePath = require.resolve('../src/config/database');
const savedDatabase = require.cache[databasePath];
const stub = new Module(databasePath);
stub.exports = {};
stub.loaded = true;
require.cache[databasePath] = stub;
const { FirebaseAuthority } = require('../src/services/firebaseAuthority');
if (savedDatabase) require.cache[databasePath] = savedDatabase;
else delete require.cache[databasePath];
const { enabledSocialProviders, parseSocialCredential } = require('../src/services/socialAuth');
const settings = { projectId: 'demo-calibrate', apiKey: 'synthetic-key', origin: 'https://example.invalid' };

/** Inject a provider and database with observable side effects; reconciliation itself has existing integration coverage. */
function fixture(options = {}) {
  const calls = { requests: [], creates: [], verifications: [], lookups: [] };
  let identity = options.identity === undefined ? { user_id: 7 } : options.identity;
  const token = { uid: 'provider-uid', aud: settings.projectId, email: 'native@example.invalid', email_verified: true,
    auth_time: Math.floor(Date.now() / 1000), firebase: { sign_in_provider: 'google.com' }, ...options.token };
  const database = {
    firebaseIdentity: { findUnique: async query => { calls.lookups.push(query); return identity; } },
    user: {
      findFirst: async () => options.collision ?? null,
      create: async query => { calls.creates.push(query); identity = { user_id: 8 }; if (options.createError) throw options.createError; return { id: 8 }; }
    }
  };
  const auth = { verifyIdToken: async (...args) => {
    calls.verifications.push(args);
    if (options.verifyError && calls.verifications.length >= (options.failVerificationAt ?? 1)) throw options.verifyError;
    return token;
  } };
  const fetcher = async (url, init) => {
    calls.requests.push({ url, body: JSON.parse(init.body), init });
    if (options.transportError) throw new Error('secret provider token must not leak');
    return { ok: !options.status, status: options.status ?? 200, json: async () => options.response ?? { idToken: 'firebase-token', localId: 'provider-uid' } };
  };
  const authority = new FirebaseAuthority(auth, database, settings, fetcher);
  let reconciliations = 0;
  authority.reconcile = async () => {
    reconciliations += 1;
    return { allowed: options.allowed ?? true, version: options.versionRace ? reconciliations : 3 };
  };
  return { authority, calls };
}
const google = { provider: 'google.com', idToken: 'opaque+provider&token' };

test('providers are opt-in and unavailable under the local authority', () => {
  assert.deepEqual(enabledSocialProviders({ AUTH_PROVIDER: 'local', FIREBASE_SOCIAL_PROVIDERS: 'google.com,apple.com' }), []);
  assert.deepEqual(enabledSocialProviders({ AUTH_PROVIDER: 'firebase' }), []);
  assert.deepEqual(enabledSocialProviders({ AUTH_PROVIDER: 'firebase', FIREBASE_SOCIAL_PROVIDERS: 'google.com, apple.com,google.com,unknown' }), ['google.com', 'apple.com']);
});
test('credential parsing rejects unsupported providers, oversize tokens and missing Apple nonce', () => {
  for (const body of [null, {}, { provider: 'password', id_token: 'x' }, { provider: 'google.com', id_token: 'x'.repeat(16385) }, { provider: 'apple.com', id_token: 'x' }]) {
    assert.equal(parseSocialCredential(body), null);
  }
  assert.deepEqual(parseSocialCredential({ provider: 'apple.com', id_token: 'x', nonce: 'a'.repeat(64), email: 'untrusted' }), { provider: 'apple.com', idToken: 'x', nonce: 'a'.repeat(64) });
});
test('Google credentials exchange through Firebase and resolve exclusively by project/UID', async () => {
  const { authority, calls } = fixture();
  assert.deepEqual(await authority.authenticateSocial(google, false, true), { userId: 7, version: 3 });
  assert.deepEqual(calls.verifications, [['firebase-token', true], ['firebase-token', true]]);
  assert.deepEqual(calls.lookups[0].where, { project_id_uid: { project_id: settings.projectId, uid: 'provider-uid' } });
  const body = calls.requests[0].body;
  assert.equal(new URLSearchParams(body.postBody).get('id_token'), google.idToken);
  assert.equal(body.requestUri, settings.origin);
  assert.equal(body.idToken, undefined);
  assert.equal(calls.creates.length, 0);
});
test('Apple uses the raw nonce and verified token email, including private relay accounts', async () => {
  const { authority, calls } = fixture({ identity: null, token: { email: 'private@privaterelay.appleid.com', firebase: { sign_in_provider: 'apple.com' } } });
  await authority.authenticateSocial({ provider: 'apple.com', idToken: 'apple-token', nonce: 'a'.repeat(64) }, true, true);
  assert.equal(new URLSearchParams(calls.requests[0].body.postBody).get('nonce'), 'a'.repeat(64));
  assert.equal(calls.creates[0].data.email, 'private@privaterelay.appleid.com');
  assert.ok(calls.creates[0].data.legal_acceptances.create.terms_version);
  assert.equal(calls.creates[0].data.firebase_identity.create.uid, 'provider-uid');
});
test('login never creates an unregistered SQL user and registration never adopts an email collision', async () => {
  const login = fixture({ identity: null });
  await assert.rejects(login.authority.authenticateSocial(google, false, true), { code: 'SOCIAL_REGISTRATION_REQUIRED' });
  assert.equal(login.calls.creates.length, 0);
  const conflict = fixture({ identity: null, collision: { id: 99 } });
  await assert.rejects(conflict.authority.authenticateSocial(google, true, true), { code: 'SOCIAL_ACCOUNT_CONFLICT' });
  assert.equal(conflict.calls.creates.length, 0);
});
test('concurrent same-UID registration can recover a unique conflict', async () => {
  const { authority } = fixture({ identity: null, createError: { code: 'P2002' } });
  assert.deepEqual(await authority.authenticateSocial(google, true, true), { userId: 8, version: 3 });
});
for (const token of [
  { uid: 'other' }, { aud: 'other-project' }, { email_verified: false }, { email: undefined },
  { firebase: { sign_in_provider: 'password' } }, { firebase: { sign_in_provider: 'google.com', tenant: 'other' } },
  { auth_time: undefined }, { auth_time: 0 }, { auth_time: Math.floor(Date.now() / 1000) + 120 }
]) test(`reject invalid verified claims ${JSON.stringify(token)}`, async () => {
  const { authority, calls } = fixture({ token });
  await assert.rejects(authority.authenticateSocial(google, true, true), { code: 'SOCIAL_AUTH_REJECTED' });
  assert.equal(calls.lookups.length, 0);
});
for (const options of [
  { allowed: false }, { versionRace: true }, { verifyError: { code: 'auth/id-token-revoked' } },
  { verifyError: { code: 'auth/id-token-revoked' }, failVerificationAt: 2 },
  { response: { needConfirmation: true } }, { status: 400, response: { error: { message: 'INVALID_IDP_RESPONSE' } } }
]) test(`fail closed on provider rejection or revocation ${JSON.stringify(options)}`, async () => {
  await assert.rejects(fixture(options).authority.authenticateSocial(google, false, true), /SOCIAL_/);
});
test('provider outages expose no provider response or credential details', async () => {
  await assert.rejects(fixture({ transportError: true }).authority.authenticateSocial(google, false, true), { message: 'Credential provider unavailable' });
});
