/** @file Explicit live Firebase BCRYPT/custom-token rehearsal using a disposable synthetic identity; no application data or email is sent. */
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { applicationDefault, initializeApp, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { hash } = require('bcryptjs');
/** Exercise the selected cloud project and always remove only this attempt's synthetic identity. */
async function main() {
const projectId = process.env.FIREBASE_PROJECT_ID;
assert.equal(process.argv[2], '--project');
assert.equal(process.argv[3], projectId, 'Explicit project must match FIREBASE_PROJECT_ID.');
assert.match(projectId ?? '', /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
assert.ok(process.env.FIREBASE_API_KEY && process.env.FIREBASE_SERVICE_ACCOUNT);
assert.ok(!process.env.FIREBASE_AUTH_EMULATOR_HOST, 'This check must reach the real provider.');
const app = initializeApp({ projectId, credential: applicationDefault(), serviceAccountId: process.env.FIREBASE_SERVICE_ACCOUNT });
const auth = getAuth(app);
const uid = `cal_smoke_${randomUUID()}`;
const email = `${uid}@example.invalid`;
const password = randomBytes(24).toString('base64url');
let owned = false;
let stage = 'inspect synthetic identity';

/** Keep provider responses private; tests report only the expected operation and HTTP status. */
async function request(method, body) {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${encodeURIComponent(process.env.FIREBASE_API_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  return { status: response.status, data: await response.json() };
}

try {
  assert.equal((await auth.getUsers([{ uid }, { email }])).users.length, 0, 'Synthetic UID/email must be unused.');
  owned = true;
  stage = 'import BCRYPT identity';
  const result = await auth.importUsers([{ uid, email, emailVerified: false, passwordHash: Buffer.from(await hash(password, 10)) }], { hash: { algorithm: 'BCRYPT' } });
  assert.equal(result.successCount, 1, 'BCRYPT import must succeed.');
  stage = 'sign in imported password';
  const signed = await request('signInWithPassword', { email, password, returnSecureToken: true });
  assert.equal(signed.status, 200, 'Imported password must sign in.');
  stage = 'verify imported identity token';
  const token = await auth.verifyIdToken(signed.data.idToken, true);
  assert.equal(token.uid, uid);
  assert.equal(token.aud, projectId);
  assert.equal((await request('signInWithPassword', { email, password: `${password}-wrong`, returnSecureToken: true })).status, 400);
  stage = 'sign keyless custom token';
  const custom = await auth.createCustomToken(uid);
  stage = 'exchange custom token';
  const customSigned = await request('signInWithCustomToken', { token: custom, returnSecureToken: true });
  assert.equal(customSigned.status, 200, 'Keyless custom-token exchange must succeed for an existing user.');
  assert.equal((await auth.verifyIdToken(customSigned.data.idToken, true)).uid, uid);
  stage = 'reject direct client signup and deletion';
  assert.equal((await request('signUp', { email: `blocked_${email}`, password, returnSecureToken: true })).status, 400, 'Client signup must be disabled.');
  assert.equal((await request('delete', { idToken: signed.data.idToken })).status, 400, 'Client deletion must be disabled.');
  stage = 'disable provider identity';
  await auth.updateUser(uid, { disabled: true });
  await assert.rejects(auth.verifyIdToken(signed.data.idToken, true), error => error.code === 'auth/user-disabled');
  console.log('Cloud Firebase checks passed: BCRYPT import/sign-in, verified project/UID, keyless custom tokens, disabled client signup/deletion, account disablement. No email sent.');
} catch (error) {
  const code = /^[a-zA-Z0-9_/-]+$/.test(String(error.code)) ? String(error.code) : 'unavailable';
  console.error(`Cloud Firebase rehearsal failed at ${stage} (${code}); no provider tokens, credentials or response bodies were logged.`);
  process.exitCode = 1;
} finally {
  if (owned) {
    try { await auth.deleteUser(uid); }
    catch (error) {
      if (error.code !== 'auth/user-not-found') { console.error(`Synthetic Firebase identity needs cleanup: ${uid}`); process.exitCode = 1; }
    }
  }
  await deleteApp(app);
}
}

main().catch(() => { console.error('Cloud Firebase rehearsal configuration rejected.'); process.exitCode = 1; });
