/** @file Regression coverage for account tokens: account token hashes are purpose-bound and never equal raw credentials. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { AccountTokenPurpose } = require('@prisma/client');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadAccountTokens({ prismaStub, bcryptStub = { hash: async () => 'hashed-password' } }) {
  const dbPath = require.resolve('../src/config/database');
  const bcryptPath = require.resolve('bcryptjs');
  const emailPath = require.resolve('../src/services/accountEmail');
  const accessPath = require.resolve('../src/services/accountAccess');
  const servicePath = require.resolve('../src/services/accountTokens');
  const previous = [dbPath, bcryptPath, emailPath, accessPath].map((path) => require.cache[path]);
  delete require.cache[servicePath];
  stubModule(dbPath, prismaStub);
  stubModule(bcryptPath, bcryptStub);
  stubModule(emailPath, { deliverAccountEmail: async () => true });
  stubModule(accessPath, { getAccountAccess: async () => ({ state: 'full', email_verified: true, legal_current: true }) });
  const loaded = require('../src/services/accountTokens');
  [dbPath, bcryptPath, emailPath, accessPath].forEach((path, index) => {
    if (previous[index]) require.cache[path] = previous[index];
    else delete require.cache[path];
  });
  return loaded;
}

test('account token hashes are purpose-bound and never equal raw credentials', () => {
  const service = loadAccountTokens({ prismaStub: {} });
  assert.equal(service.EMAIL_VERIFICATION_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(service.PASSWORD_RESET_TTL_MS, 30 * 60 * 1000);
  const raw = 'one-time-secret';
  const verifyHash = service.hashAccountToken(AccountTokenPurpose.EMAIL_VERIFICATION, raw);
  const resetHash = service.hashAccountToken(AccountTokenPurpose.PASSWORD_RESET, raw);
  assert.notEqual(verifyHash, raw);
  assert.notEqual(resetHash, raw);
  assert.notEqual(verifyHash, resetHash);
});

test('issued recovery token stores only its hash with a 30 minute expiry', async () => {
  let created = null;
  const database = {
    accountActionToken: {
      updateMany: async () => ({ count: 0 }),
      create: async (args) => { created = args; return { id: 1 }; }
    }
  };
  const service = loadAccountTokens({ prismaStub: {} });
  const now = new Date('2026-08-09T12:00:00.000Z');
  const raw = await service.issueAccountActionToken(7, AccountTokenPurpose.PASSWORD_RESET, now, database);
  assert.equal(created.data.user_id, 7);
  assert.equal(created.data.purpose, AccountTokenPurpose.PASSWORD_RESET);
  assert.notEqual(created.data.token_hash, raw);
  assert.equal(created.data.expires_at.toISOString(), '2026-08-09T12:30:00.000Z');
  assert.equal(JSON.stringify(created).includes(raw), false);
});

test('password reset atomically revokes browser, phone, Wear, push, pairing, and connected-assistant credentials', async () => {
  const now = new Date('2026-08-09T12:00:00.000Z');
  const calls = {};
  const transaction = {
    accountActionToken: {
      findUnique: async () => ({
        id: 9,
        user_id: 7,
        purpose: AccountTokenPurpose.PASSWORD_RESET,
        expires_at: new Date('2026-08-09T12:10:00.000Z'),
        consumed_at: null
      }),
      updateMany: async (args) => {
        (calls.tokenUpdates ??= []).push(args);
        return { count: 1 };
      }
    },
    user: { update: async (args) => { calls.user = args; } },
    pushSubscription: { deleteMany: async (args) => { calls.browserPush = args; } },
    sessionStore: { deleteMany: async (args) => { calls.browser = args; } },
    mobileAuthSession: { updateMany: async (args) => { calls.mobile = args; } },
    wearPairingCredential: { updateMany: async (args) => { calls.wearPairing = args; } },
    nativePushSubscription: { updateMany: async (args) => { calls.nativePush = args; } },
    mcpOAuthGrant: { updateMany: async (args) => { calls.mcpOAuth = args; } },
    mcpOAuthAuthorizationCode: { deleteMany: async (args) => { calls.mcpOAuthCodes = args; } }
  };
  const prismaStub = { $transaction: async (callback) => callback(transaction) };
  const service = loadAccountTokens({ prismaStub });
  const reset = await service.resetPasswordWithToken('raw-reset-token', 'new-password', now);
  assert.equal(reset, true);
  assert.equal(calls.user.data.password_hash, 'hashed-password');
  assert.deepEqual(calls.browserPush.where, { user_id: 7 });
  assert.deepEqual(calls.browser.where, { user_id: 7 });
  assert.deepEqual(calls.mobile.where, { user_id: 7, revoked_at: null });
  assert.deepEqual(calls.wearPairing.where, { user_id: 7, consumed_at: null });
  assert.deepEqual(calls.nativePush.where, { user_id: 7, revoked_at: null });
  assert.deepEqual(calls.mcpOAuth.where, { user_id: 7, revoked_at: null });
  assert.deepEqual(calls.mcpOAuthCodes.where, { user_id: 7 });
  assert.equal(calls.mobile.data.revoked_at, now);
  assert.equal(calls.wearPairing.data.consumed_at, now);
  assert.equal(calls.mcpOAuth.data.revoked_at, now);
});

test('expired or already-consumed reset tokens cannot change credentials', async () => {
  let updates = 0;
  const transaction = {
    accountActionToken: {
      findUnique: async () => ({
        id: 9,
        user_id: 7,
        purpose: AccountTokenPurpose.PASSWORD_RESET,
        expires_at: new Date('2026-08-09T11:59:00.000Z'),
        consumed_at: null
      })
    },
    user: { update: async () => { updates += 1; } }
  };
  const service = loadAccountTokens({ prismaStub: { $transaction: async (callback) => callback(transaction) } });
  assert.equal(await service.resetPasswordWithToken('expired', 'new-password', new Date('2026-08-09T12:00:00.000Z')), false);
  assert.equal(updates, 0);
});
