/** @file Exercise Firebase credential lifecycle and SQL revocation using only synthetic accounts in owned loopback emulators. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');

const databaseUrl = process.env.CALIBRATE_AUTH_TEST_DATABASE_URL;
const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;

test('Firebase authority preserves account bindings and revokes every credential family', { skip: !databaseUrl || !emulator, timeout: 150000 }, async t => {
  const url = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.match(url.pathname, /^\/calibrate_test[^/]*$/);
  assert.match(emulator, /^127\.0\.0\.1:\d+$/);
  assert.equal(process.env.FIREBASE_PROJECT_ID, 'demo-calibrate');
  assert.equal(process.env.AUTH_PROVIDER, 'firebase');
  const schema = `auth_firebase_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set('schema', schema);
  process.env.DATABASE_URL = url.toString();
  let database, auth;
  const uids = [];
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { env: process.env, stdio: 'pipe', timeout: 45000 });
    database = require('../src/config/database');
    const prisma = database.default;
    const { firebaseAuthority, FirebaseAuthority, firebaseSessionAllowed } = require('../src/services/firebaseAuthority');
    const { CredentialProviderUnavailable } = require('../src/services/credentialVerification');
    const { getAuth } = require('firebase-admin/auth');
    const { getApp } = require('firebase-admin/app');
    const authority = firebaseAuthority();
    auth = getAuth(getApp('calibrate-auth'));
    const settings = { projectId: 'demo-calibrate', apiKey: 'emulator-only', origin: 'http://localhost:3000', emulatorHost: emulator };
    const password = 'Synthetic-initial-password-4321';
    const replacement = 'Synthetic-replacement-password-9876';
    const future = new Date(Date.now() + 3600000);
    const create = async () => {
      const user = await authority.register(`${randomUUID()}@example.invalid`, password, true);
      const identity = await prisma.firebaseIdentity.findUniqueOrThrow({ where: { user_id: user.id } });
      uids.push(identity.uid);
      return { ...user, uid: identity.uid };
    };
    const credentials = async user => {
      const browser = await prisma.sessionStore.create({ data: { sid: randomUUID(), user_id: user.id, sess: { passport: { user: user.id } }, expire: future } });
      await prisma.pushSubscription.create({ data: { user_id: user.id, session_sid: browser.sid, endpoint: `https://example.invalid/${randomUUID()}`, p256dh: 'synthetic', auth: 'synthetic' } });
      const mobile = await prisma.mobileAuthSession.create({ data: { user_id: user.id, device_id: randomUUID(), device_platform: 'ANDROID_PHONE', access_token_hash: randomUUID(), refresh_token_hash: randomUUID(), access_expires_at: future, refresh_expires_at: future } });
      await prisma.nativePushSubscription.create({ data: { user_id: user.id, mobile_auth_session_id: mobile.id, device_id: mobile.device_id, provider: 'EXPO', token: randomUUID() } });
      await prisma.wearPairingCredential.create({ data: { user_id: user.id, issuing_mobile_session_id: mobile.id, token_hash: randomUUID(), server_origin: settings.origin, watch_device_id: randomUUID(), protocol_version: 1, challenge: 'synthetic', watch_public_key_spki: 'synthetic', expires_at: future } });
      const client = await prisma.mcpOAuthClient.create({ data: { client_id: randomUUID(), metadata_json: {} } });
      await prisma.mcpOAuthGrant.create({ data: { user_id: user.id, client_id: client.client_id, scopes: ['read'], resource: settings.origin } });
      await prisma.mcpOAuthAuthorizationCode.create({ data: { code_hash: randomUUID(), user_id: user.id, client_id: client.client_id, redirect_uri: settings.origin, scopes: ['read'], code_challenge: 'synthetic', resource: settings.origin, expires_at: future } });
    };
    const revoked = async user => {
      assert.equal(await prisma.sessionStore.count({ where: { user_id: user.id } }), 0);
      assert.equal(await prisma.pushSubscription.count({ where: { user_id: user.id } }), 0);
      assert.equal(await prisma.mobileAuthSession.count({ where: { user_id: user.id, revoked_at: null } }), 0);
      assert.equal(await prisma.nativePushSubscription.count({ where: { user_id: user.id, revoked_at: null } }), 0);
      assert.equal(await prisma.wearPairingCredential.count({ where: { user_id: user.id, consumed_at: null } }), 0);
      assert.equal(await prisma.mcpOAuthGrant.count({ where: { user_id: user.id, revoked_at: null } }), 0);
      assert.equal(await prisma.mcpOAuthAuthorizationCode.count({ where: { user_id: user.id } }), 0);
    };
    const actionCode = async (user, kind) => {
      assert.equal(await authority.sendEmail(user.id, kind), true);
      const response = await fetch(`http://${emulator}/emulator/v1/projects/demo-calibrate/oobCodes`);
      assert.equal(response.ok, true);
      const payload = await response.json();
      const code = payload.oobCodes.filter(row => row.email === user.email && row.requestType === kind).at(-1)?.oobCode;
      assert.equal(typeof code, 'string');
      return code;
    };
    await t.test('registration, hosted consent, provider email verification and password sign-in', async () => {
      const user = await create();
      assert.equal(user.email_verified_at, null);
      assert.equal(await prisma.legalAcceptance.count({ where: { user_id: user.id } }), 1);
      assert.equal(typeof await authority.verify(user.id, password), 'number');
      assert.equal(await authority.verify(user.id, 'wrong-password'), null);
      const code = await actionCode(user, 'VERIFY_EMAIL');
      assert.equal(await authority.confirmEmail(code), user.id);
      assert.ok((await prisma.user.findUnique({ where: { id: user.id } })).email_verified_at);
      assert.equal(await authority.confirmEmail('invalid-code'), null);
      assert.equal(await firebaseSessionAllowed(user.id), true);
    });
    await t.test('MCP reauthentication accepts long passwords set through Firebase recovery', async () => {
      const user = await create();
      const longPassword = 'Synthetic-long-password-'.repeat(5);
      await auth.updateUser(user.uid, { password: longPassword, emailVerified: true });
      await authority.reconcile(user.id);
      const { McpOAuthService } = require('../src/services/mcpOAuth');
      const service = new McpOAuthService(prisma);
      const client = await service.saveClient({ client_id: randomUUID(), redirect_uris: ['http://127.0.0.1:49000/callback'], token_endpoint_auth_method: 'none' });
      const request = await service.beginAuthorization({ clientId: client.client_id, redirectUri: client.redirect_uris[0], scopes: ['calibrate:food:read'], codeChallenge: 'A'.repeat(43), resource: `${settings.origin}/mcp` });
      const approved = await service.approveAuthorization({ requestId: request.id, email: user.email, password: longPassword });
      assert.match(approved.code, /^calibrate_mcp_code_/);
      assert.equal(await prisma.mcpOAuthAuthorizationCode.count({ where: { user_id: user.id } }), 1);
    });
    await t.test('Firebase recovery replaces credentials and revokes browser, native, Wear, push and MCP', async () => {
      const user = await create();
      await credentials(user);
      const code = await actionCode(user, 'PASSWORD_RESET');
      assert.equal(await authority.resetPassword(code, replacement), true);
      await revoked(user);
      assert.equal(await authority.verify(user.id, password), null);
      assert.equal(typeof await authority.verify(user.id, replacement), 'number');
      assert.equal(await authority.resetPassword(code, password), false);
    });
    await t.test('provider-hosted reset is detected without passing through Calibrate', async () => {
      const user = await create();
      await credentials(user);
      await auth.updateUser(user.uid, { password: replacement });
      // Explicitly advance emulator validSince; Firebase timestamps have second precision.
      await fetch(`http://${emulator}/identitytoolkit.googleapis.com/v1/projects/demo-calibrate/accounts:update`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ localId: user.uid, validSince: String(Math.floor(Date.now() / 1000) + 2) }) });
      assert.equal(await firebaseSessionAllowed(user.id), false);
      await revoked(user);
    });
    await t.test('password changes explicitly revoke even within the same provider timestamp second', async () => {
      const user = await create();
      await credentials(user);
      await authority.changePassword(user.id, replacement);
      await revoked(user);
      assert.equal(await authority.verify(user.id, password), null);
      assert.equal(typeof await authority.verify(user.id, replacement), 'number');
    });
    for (const change of ['disable', 'delete', 'email']) {
      await t.test(`external ${change} cannot retain local access or link to a different identity`, async () => {
        const user = await create();
        await credentials(user);
        if (change === 'delete') await auth.deleteUser(user.uid);
        else await auth.updateUser(user.uid, change === 'disable' ? { disabled: true } : { email: `${randomUUID()}@example.invalid` });
        assert.equal(await firebaseSessionAllowed(user.id), false);
        assert.equal(await authority.verify(user.id, password), null);
        await revoked(user);
      });
    }
    await t.test('imported identity bindings preserve SQL IDs and reject email adoption', async () => {
      const { hash } = require('bcryptjs');
      const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.invalid`, password_hash: await hash(password, 10), email_verified_at: null } });
      const uid = `import_${randomUUID()}`;
      uids.push(uid);
      const imported = await auth.importUsers([{ uid, email: user.email, emailVerified: false, passwordHash: Buffer.from(user.password_hash) }], { hash: { algorithm: 'BCRYPT' } });
      assert.equal(imported.successCount, 1);
      assert.equal(await authority.verify(user.id, password), null);
      // Auth Emulator uses its own hash format; cloud smoke testing owns real BCRYPT compatibility.
      await auth.updateUser(uid, { password });
      await prisma.firebaseIdentity.create({ data: { user_id: user.id, installation_id: 'synthetic-install', source_id: 'synthetic-source', project_id: settings.projectId, uid } });
      assert.equal(typeof await authority.verify(user.id, password), 'number');
      await assert.rejects(prisma.firebaseIdentity.update({ where: { user_id: user.id }, data: { uid: 'different-user' } }));
      assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).password_hash, user.password_hash);
    });
    await t.test('provider outages fail closed and do not use the retained bcrypt hash', async () => {
      const user = await create();
      const unavailable = new FirebaseAuthority({ getUser: async () => { throw new Error('sensitive provider detail'); } }, prisma, settings);
      await assert.rejects(unavailable.verify(user.id, password), error => error instanceof CredentialProviderUnavailable && !error.message.includes('sensitive'));
      const unavailableRest = new FirebaseAuthority(auth, prisma, settings, async () => { throw new Error('sensitive response'); });
      await assert.rejects(unavailableRest.verify(user.id, password), error => error instanceof CredentialProviderUnavailable && !error.message.includes('sensitive'));
    });
    await t.test('password verification cannot cross a concurrent security generation change', async () => {
      const user = await create();
      const racing = new FirebaseAuthority(auth, prisma, settings, async (...args) => {
        const response = await fetch(...args);
        await auth.updateUser(user.uid, { emailVerified: true });
        return response;
      });
      assert.equal(await racing.verify(user.id, password), null);
      assert.equal(typeof await authority.verify(user.id, password), 'number');
    });
    await t.test('failed provider deletion leaves durable revoked intent and retries complete both stores', async () => {
      const user = await create();
      await credentials(user);
      const failing = new FirebaseAuthority({ deleteUser: async () => { throw new Error('synthetic outage'); } }, prisma, settings);
      await assert.rejects(failing.deleteAccount(user.id), CredentialProviderUnavailable);
      assert.ok((await prisma.firebaseIdentity.findUnique({ where: { user_id: user.id } })).deletion_pending_at);
      await revoked(user);
      assert.equal(await authority.verify(user.id, password), null);
      await authority.retryDeletions();
      assert.equal(await prisma.user.count({ where: { id: user.id } }), 0);
      await assert.rejects(auth.getUser(user.uid), error => error.code === 'auth/user-not-found');
    });
  } finally {
    if (auth) for (const uid of uids) await auth.deleteUser(uid).catch(() => {});
    if (database) await database.disconnectDatabase();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
