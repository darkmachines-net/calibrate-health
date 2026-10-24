/** @file Regression coverage for mobile auth: mobile auth parses Android device metadata. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');

function stubModule(resolvedPath, exports) {
  const moduleInstance = new Module(resolvedPath);
  moduleInstance.exports = exports;
  moduleInstance.loaded = true;
  require.cache[resolvedPath] = moduleInstance;
}

function loadMobileAuthService({ prismaStub }) {
  const dbPath = require.resolve('../src/config/database');
  const servicePath = require.resolve('../src/services/mobileAuth');
  const dependencyPaths = [
    require.resolve('../src/services/mobileSessionCredentials'),
    require.resolve('../src/services/wearPairing')
  ];

  const previousDbModule = require.cache[dbPath];
  const previousDependencyModules = dependencyPaths.map((path) => require.cache[path]);
  delete require.cache[servicePath];
  dependencyPaths.forEach((path) => delete require.cache[path]);

  stubModule(dbPath, prismaStub);

  const loaded = require('../src/services/mobileAuth');

  if (previousDbModule) require.cache[dbPath] = previousDbModule;
  else delete require.cache[dbPath];
  dependencyPaths.forEach((path, index) => {
    const previous = previousDependencyModules[index];
    if (previous) require.cache[path] = previous;
    else delete require.cache[path];
  });

  return loaded;
}

const baseUser = {
  id: 4,
  email: 'native@example.com',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  weight_unit: 'KG',
  height_unit: 'CM',
  timezone: 'UTC',
  language: 'en',
  reminder_log_weight_enabled: true,
  reminder_log_food_enabled: true,
  haptics_enabled: true,
  date_of_birth: null,
  sex: null,
  height_mm: null,
  activity_level: null,
  profile_image: null,
  profile_image_mime_type: null
};

const EXCHANGE_ID = 'f6ca2d91-d450-4ee0-9f09-7c66e6eb7358';
const OTHER_EXCHANGE_ID = '77ba9232-8d0b-4721-82f0-326fb4eaa3e5';

function createWearKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey,
    publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  };
}

test('mobile auth parses Android device metadata', () => {
  const { parseMobileDevicePayload, serializeMobileDevicePlatform } = loadMobileAuthService({
    prismaStub: {}
  });

  const parsed = parseMobileDevicePayload({
    device_id: 'emulator-1',
    device_platform: 'android_phone',
    device_name: 'Pixel'
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.device.deviceId, 'emulator-1');
  assert.equal(serializeMobileDevicePlatform(parsed.device.devicePlatform), 'android_phone');
});

test('mobile auth parses iPhone and iPad device metadata', () => {
  const { parseMobileDevicePayload, serializeMobileDevicePlatform } = loadMobileAuthService({
    prismaStub: {}
  });

  const parsed = parseMobileDevicePayload({
    device_id: 'ios-install-1',
    device_platform: 'ios',
    device_name: 'iPad'
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.device.deviceId, 'ios-install-1');
  assert.equal(serializeMobileDevicePlatform(parsed.device.devicePlatform), 'ios');
});

test('Wear pairing origins require HTTPS except on Android-approved local and private hosts', () => {
  const { normalizePairingServerOrigin } = loadMobileAuthService({ prismaStub: {} });
  assert.equal(normalizePairingServerOrigin('https://public.example/'), 'https://public.example');
  assert.equal(normalizePairingServerOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizePairingServerOrigin('http://10.0.2.2:3000'), 'http://10.0.2.2:3000');
  assert.equal(normalizePairingServerOrigin('http://192.168.0.160:3000'), 'http://192.168.0.160:3000');
  assert.equal(normalizePairingServerOrigin('http://172.31.4.8:3000'), 'http://172.31.4.8:3000');
  assert.equal(normalizePairingServerOrigin('http://calibrate.local:3000'), 'http://calibrate.local:3000');
  assert.equal(normalizePairingServerOrigin('http://public.example'), null);
  assert.equal(normalizePairingServerOrigin('http://172.32.0.1'), null);
  assert.equal(normalizePairingServerOrigin(
    'http://192.168.0.160:3000', { NODE_ENV: 'production' }, () => {}
  ), null);
  const warnings = [];
  assert.equal(normalizePairingServerOrigin(
    'http://192.168.0.160:3000',
    { NODE_ENV: 'staging', ALLOW_INSECURE_WEAR_PAIRING: 'true' },
    (message) => warnings.push(message)
  ), 'http://192.168.0.160:3000');
  assert.match(warnings[0], /health data can be intercepted/i);
});

test('mobile auth issues a short-lived hashed Wear credential only from an active phone session', async () => {
  let credentialCreate;
  const tx = {
    mobileAuthSession: {
      updateMany: async ({ where }) => {
        assert.equal(where.id, 12);
        assert.equal(where.user_id, 4);
        assert.equal(where.device_platform, 'ANDROID_PHONE');
        return { count: 1 };
      }
    },
    wearPairingCredential: {
      deleteMany: async () => ({ count: 0 }),
      findMany: async () => [],
      create: async (args) => { credentialCreate = args; return { id: 1 }; }
    }
  };
  const { hashMobileToken, issueWearPairingCredential } = loadMobileAuthService({
    prismaStub: { $transaction: async (callback) => callback(tx) }
  });
  const keyPair = createWearKeyPair();
  const now = new Date('2026-07-11T12:00:00.000Z');
  const result = await issueWearPairingCredential({
    userId: 4,
    issuingSessionId: 12,
    serverOrigin: 'https://health.example/',
    watchDeviceId: 'watch-install-1',
    watchDeviceName: 'Galaxy Watch Ultra',
    protocolVersion: 1,
    watchPublicKeySpki: keyPair.publicKeySpki,
    now
  });

  assert.equal(result.ok, true);
  assert.match(result.credential.pairingToken, /^wear_pair_/);
  assert.equal(result.credential.serverOrigin, 'https://health.example');
  assert.equal(result.credential.watchDeviceId, 'watch-install-1');
  assert.equal(result.credential.protocolVersion, 1);
  assert.equal(result.credential.expiresAt.toISOString(), '2026-07-11T12:05:00.000Z');
  assert.equal(credentialCreate.data.token_hash, hashMobileToken(result.credential.pairingToken));
  assert.notEqual(credentialCreate.data.token_hash, result.credential.pairingToken);
  assert.equal(credentialCreate.data.watch_public_key_spki, keyPair.publicKeySpki);
  assert.equal(credentialCreate.data.watch_device_name, 'Galaxy Watch Ultra');
  assert.ok(credentialCreate.data.challenge);
});

test('Wear pairing issuance permits concurrent tickets while pruning overflow and stale rows', async () => {
  const deleteCalls = [];
  const tx = {
    mobileAuthSession: { updateMany: async () => ({ count: 1 }) },
    wearPairingCredential: {
      deleteMany: async (args) => { deleteCalls.push(args); return { count: 1 }; },
      findMany: async ({ skip }) => {
        assert.equal(skip, 4);
        return [{ id: 10 }, { id: 9 }];
      },
      create: async () => ({ id: 20 })
    }
  };
  const { issueWearPairingCredential } = loadMobileAuthService({
    prismaStub: { $transaction: async (callback) => callback(tx) }
  });
  const keyPair = createWearKeyPair();
  const result = await issueWearPairingCredential({
    userId: 4,
    issuingSessionId: 12,
    serverOrigin: 'https://health.example',
    watchDeviceId: 'watch-new',
    protocolVersion: 1,
    watchPublicKeySpki: keyPair.publicKeySpki,
    now: new Date('2026-07-11T12:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(deleteCalls.length, 2);
  assert.deepEqual(deleteCalls[1].where.id.in, [10, 9]);
});

test('mobile auth exchanges a pairing token once for a Wear OS session bound to the same server', async () => {
  const token = 'wear_pair_one-time-token';
  let consumed = false;
  let sessionCreate;
  const keyPair = createWearKeyPair();
  const credential = {
    id: 31,
    user_id: 4,
    token_hash: 'hash-filled-by-test',
    server_origin: 'https://health.example',
    watch_device_id: 'watch-install-1',
    watch_device_name: 'Galaxy Watch Ultra',
    protocol_version: 1,
    challenge: 'server-challenge',
    watch_public_key_spki: keyPair.publicKeySpki,
    issuing_mobile_session_id: 12,
    exchange_id_hash: null,
    created_mobile_session_id: null,
    expires_at: new Date('2026-07-11T12:05:00.000Z'),
    consumed_at: null
  };
  let orphanRevoked = false;
  let orphanPushRevoked = false;
  const tx = {
    wearPairingCredential: {
      findUnique: async () => credential,
      updateMany: async ({ data }) => {
        if (consumed) return { count: 0 };
        consumed = true;
        credential.consumed_at = data.consumed_at;
        credential.exchange_id_hash = data.exchange_id_hash;
        return { count: 1 };
      },
      update: async ({ data }) => {
        credential.created_mobile_session_id = data.created_mobile_session_id;
        return credential;
      }
    },
    user: { findUnique: async () => baseUser },
    mobileAuthSession: {
      updateMany: async ({ where, data }) => {
        if (where.device_platform === 'WEAR_OS') {
          orphanRevoked = Boolean(data.revoked_at);
          return { count: 1 };
        }
        assert.equal(where.id, 12);
        return { count: 1 };
      },
      create: async (args) => { sessionCreate = args; return { id: 50 }; }
    },
    nativePushSubscription: {
      updateMany: async ({ where, data }) => {
        assert.equal(where.mobile_auth_session_id, 50);
        orphanPushRevoked = Boolean(data.revoked_at);
        return { count: 1 };
      }
    }
  };
  const { buildWearPairingChallengePayload, exchangeWearPairingCredential, hashMobileToken } = loadMobileAuthService({
    prismaStub: { $transaction: async (callback) => callback(tx) }
  });
  credential.token_hash = hashMobileToken(token);
  const signature = crypto.sign(
    'sha256',
    buildWearPairingChallengePayload({
      serverOrigin: credential.server_origin,
      watchDeviceId: credential.watch_device_id,
      exchangeId: EXCHANGE_ID,
      challenge: credential.challenge
    }),
    keyPair.privateKey
  ).toString('base64url');
  const request = {
    pairing_token: token,
    server_origin: 'https://health.example',
    watch_device_id: 'watch-install-1',
    protocol_version: 1,
    exchange_id: EXCHANGE_ID,
    challenge_signature: signature
  };

  const first = await exchangeWearPairingCredential(request, new Date('2026-07-11T12:01:00.000Z'));
  const otherExchangeSignature = crypto.sign(
    'sha256',
    buildWearPairingChallengePayload({
      serverOrigin: credential.server_origin,
      watchDeviceId: credential.watch_device_id,
      exchangeId: OTHER_EXCHANGE_ID,
      challenge: credential.challenge
    }),
    keyPair.privateKey
  ).toString('base64url');
  const differentExchange = await exchangeWearPairingCredential({
    ...request,
    exchange_id: OTHER_EXCHANGE_ID,
    challenge_signature: otherExchangeSignature
  }, new Date('2026-07-11T12:01:00.500Z'));
  assert.equal(differentExchange.ok, false);
  assert.equal(differentExchange.code, 'PAIRING_CREDENTIAL_USED');
  assert.equal(orphanRevoked, false);

  const retrySignature = crypto.sign(
    'sha256',
    buildWearPairingChallengePayload({
      serverOrigin: credential.server_origin,
      watchDeviceId: credential.watch_device_id,
      exchangeId: EXCHANGE_ID,
      challenge: credential.challenge
    }),
    keyPair.privateKey
  ).toString('base64url');
  const replay = await exchangeWearPairingCredential(
    { ...request, challenge_signature: retrySignature },
    new Date('2026-07-11T12:01:01.000Z')
  );

  assert.equal(first.ok, true);
  assert.equal(replay.ok, false);
  assert.equal(replay.status, 409);
  assert.equal(replay.code, 'PAIRING_RESPONSE_LOST');
  assert.equal(orphanRevoked, true);
  assert.equal(orphanPushRevoked, true);
  assert.equal(sessionCreate.data.device_id, 'watch-install-1');
  assert.equal(sessionCreate.data.device_platform, 'WEAR_OS');
  assert.deepEqual(Object.keys(first.payload.user).sort(), [
    'height_unit', 'id', 'language', 'timezone', 'weight_unit'
  ]);
  assert.ok(first.payload.accessToken);
  assert.ok(first.payload.refreshToken);
});

test('mobile auth rejects cross-server or revoked-phone Wear exchanges without consuming the token', async () => {
  let claims = 0;
  let issuerActive = true;
  const keyPair = createWearKeyPair();
  const credential = {
    id: 31,
    user_id: 4,
    server_origin: 'https://first.example',
    watch_device_id: 'watch-1',
    watch_device_name: null,
    protocol_version: 1,
    challenge: 'server-challenge',
    watch_public_key_spki: keyPair.publicKeySpki,
    issuing_mobile_session_id: 12,
    exchange_id_hash: null,
    created_mobile_session_id: null,
    expires_at: new Date('2026-07-11T12:05:00.000Z'),
    consumed_at: null
  };
  const tx = {
    wearPairingCredential: {
      findUnique: async () => credential,
      updateMany: async () => { claims += 1; return { count: 1 }; }
    },
    user: { findUnique: async () => baseUser },
    mobileAuthSession: {
      updateMany: async ({ where }) => {
        assert.equal(where.id, 12);
        return { count: issuerActive ? 1 : 0 };
      },
      create: async () => ({ id: 1 })
    }
  };
  const { buildWearPairingChallengePayload, exchangeWearPairingCredential } = loadMobileAuthService({
    prismaStub: { $transaction: async (callback) => callback(tx) }
  });
  const signature = crypto.sign(
    'sha256',
    buildWearPairingChallengePayload({
      serverOrigin: credential.server_origin,
      watchDeviceId: credential.watch_device_id,
      exchangeId: EXCHANGE_ID,
      challenge: credential.challenge
    }),
    keyPair.privateKey
  ).toString('base64url');
  const request = {
    pairing_token: 'wear_pair_server-bound',
    server_origin: 'https://second.example',
    watch_device_id: 'watch-1',
    protocol_version: 1,
    exchange_id: EXCHANGE_ID,
    challenge_signature: signature
  };

  const wrongServer = await exchangeWearPairingCredential(request, new Date('2026-07-11T12:01:00.000Z'));
  credential.server_origin = 'https://second.example';
  issuerActive = false;
  const reboundSignature = crypto.sign(
    'sha256',
    buildWearPairingChallengePayload({
      serverOrigin: credential.server_origin,
      watchDeviceId: credential.watch_device_id,
      exchangeId: EXCHANGE_ID,
      challenge: credential.challenge
    }),
    keyPair.privateKey
  ).toString('base64url');
  const revokedPhone = await exchangeWearPairingCredential(
    { ...request, challenge_signature: reboundSignature },
    new Date('2026-07-11T12:01:00.000Z')
  );

  assert.equal(wrongServer.ok, false);
  assert.equal(wrongServer.code, 'PAIRING_BINDING_MISMATCH');
  assert.equal(revokedPhone.ok, false);
  assert.equal(revokedPhone.code, 'INVALID_PAIRING_CREDENTIAL');
  assert.equal(claims, 0);
});

test('mobile auth rejects invalid Wear challenge signatures without consuming the credential', async () => {
  let claims = 0;
  const keyPair = createWearKeyPair();
  const tx = {
    wearPairingCredential: {
      findUnique: async () => ({
        id: 31,
        user_id: 4,
        server_origin: 'https://health.example',
        watch_device_id: 'watch-1',
        watch_device_name: null,
        protocol_version: 1,
        challenge: 'server-challenge',
        watch_public_key_spki: keyPair.publicKeySpki,
        issuing_mobile_session_id: 12,
        exchange_id_hash: null,
        created_mobile_session_id: null,
        expires_at: new Date('2026-07-11T12:05:00.000Z'),
        consumed_at: null
      }),
      updateMany: async () => { claims += 1; return { count: 1 }; }
    },
    mobileAuthSession: { updateMany: async () => ({ count: 1 }) }
  };
  const { exchangeWearPairingCredential } = loadMobileAuthService({
    prismaStub: { $transaction: async (callback) => callback(tx) }
  });
  const result = await exchangeWearPairingCredential({
    pairing_token: 'wear_pair_server-bound',
    server_origin: 'https://health.example',
    watch_device_id: 'watch-1',
    protocol_version: 1,
    exchange_id: EXCHANGE_ID,
    challenge_signature: crypto.randomBytes(64).toString('base64url')
  }, new Date('2026-07-11T12:01:00.000Z'));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PAIRING_SIGNATURE_INVALID');
  assert.equal(claims, 0);
});

test('expired consumed Wear retries return expiry without revoking the created session', async () => {
  let sideEffects = 0;
  const tx = {
    wearPairingCredential: {
      findUnique: async () => ({
        id: 31,
        user_id: 4,
        server_origin: 'https://health.example',
        watch_device_id: 'watch-1',
        protocol_version: 1,
        expires_at: new Date('2026-07-11T12:00:00.000Z'),
        consumed_at: new Date('2026-07-11T11:59:00.000Z'),
        exchange_id_hash: 'stored-exchange-hash',
        created_mobile_session_id: 50
      }),
      updateMany: async () => { sideEffects += 1; return { count: 1 }; }
    },
    mobileAuthSession: { updateMany: async () => { sideEffects += 1; return { count: 1 }; } },
    nativePushSubscription: { updateMany: async () => { sideEffects += 1; return { count: 1 }; } }
  };
  const { exchangeWearPairingCredential } = loadMobileAuthService({
    prismaStub: { $transaction: async (callback) => callback(tx) }
  });
  const result = await exchangeWearPairingCredential({
    pairing_token: 'wear_pair_expired',
    server_origin: 'https://health.example',
    watch_device_id: 'watch-1',
    protocol_version: 1,
    exchange_id: EXCHANGE_ID,
    challenge_signature: crypto.randomBytes(64).toString('base64url')
  }, new Date('2026-07-11T12:00:01.000Z'));

  assert.equal(result.ok, false);
  assert.equal(result.status, 410);
  assert.equal(result.code, 'PAIRING_CREDENTIAL_EXPIRED');
  assert.equal(sideEffects, 0);
});

test('mobile auth issues hashed opaque session tokens', async () => {
  const createCalls = [];
  const prismaStub = {
    user: {
      findUnique: async () => baseUser
    },
    mobileAuthSession: {
      create: async (args) => {
        createCalls.push(args);
        return { id: 9 };
      }
    }
  };

  const { issueMobileAuthPayload, parseMobileDevicePayload, hashMobileToken } = loadMobileAuthService({
    prismaStub
  });

  const device = parseMobileDevicePayload({ device_id: 'device-1' });
  assert.equal(device.ok, true);

  const payload = await issueMobileAuthPayload({
    userId: baseUser.id,
    device: device.device
  });

  assert.ok(payload.accessToken);
  assert.ok(payload.refreshToken);
  assert.notEqual(createCalls[0].data.access_token_hash, payload.accessToken);
  assert.equal(createCalls[0].data.access_token_hash, hashMobileToken(payload.accessToken));
  assert.equal(createCalls[0].data.refresh_token_hash, hashMobileToken(payload.refreshToken));
  assert.equal(payload.user.email, baseUser.email);
});

test('mobile auth validates bearer access tokens and hydrates the client user', async () => {
  let updateCall = null;
  const prismaStub = {
    mobileAuthSession: {
      findUnique: async () => ({
        id: 12,
        revoked_at: null,
        access_expires_at: new Date(Date.now() + 60_000),
        user: baseUser
      }),
      update: async (args) => {
        updateCall = args;
        return { id: args.where.id };
      }
    }
  };

  const { authenticateMobileAccessToken } = loadMobileAuthService({ prismaStub });
  const result = await authenticateMobileAccessToken('Bearer test-token');

  assert.equal(result.ok, true);
  assert.equal(result.user.id, baseUser.id);
  assert.equal(updateCall.where.id, 12);
  assert.ok(updateCall.data.last_used_at instanceof Date);
});

test('Wear bearer authentication exposes only the reduced principal', async () => {
  const prismaStub = {
    mobileAuthSession: {
      findUnique: async () => ({
        id: 45,
        device_id: 'watch-45',
        device_platform: 'WEAR_OS',
        revoked_at: null,
        access_expires_at: new Date(Date.now() + 60_000),
        user: baseUser
      }),
      update: async () => ({ id: 45 })
    }
  };
  const { authenticateMobileAccessToken } = loadMobileAuthService({ prismaStub });
  const result = await authenticateMobileAccessToken('Bearer wear-token');

  assert.equal(result.ok, true);
  assert.equal(result.devicePlatform, 'wear_os');
  assert.deepEqual(Object.keys(result.user).sort(), [
    'height_unit', 'id', 'language', 'timezone', 'weight_unit'
  ]);
});

test('mobile auth allows exactly one successor for concurrent refresh-token replays', async () => {
  const presentedToken = 'shared-refresh-token';
  let storedRefreshHash = null;
  let initialReadCount = 0;
  const waitingInitialReads = [];
  const prismaStub = {
    mobileAuthSession: {
      findUnique: async (args) => {
        if (args.where.refresh_token_hash) {
          initialReadCount += 1;
          if (initialReadCount < 2) {
            await new Promise((resolve) => waitingInitialReads.push(resolve));
          } else {
            waitingInitialReads.splice(0).forEach((resolve) => resolve());
          }
          return { id: 22 };
        }

        return { id: 22, user: baseUser };
      },
      updateMany: async (args) => {
        if (args.where.refresh_token_hash !== storedRefreshHash) {
          return { count: 0 };
        }
        storedRefreshHash = args.data.refresh_token_hash;
        return { count: 1 };
      }
    }
  };

  const { hashMobileToken, refreshMobileSession } = loadMobileAuthService({ prismaStub });
  storedRefreshHash = hashMobileToken(presentedToken);

  const results = await Promise.all([
    refreshMobileSession(presentedToken),
    refreshMobileSession(presentedToken)
  ]);

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((result) => result === null).length, 1);
  const successfulResult = results.find(Boolean);
  assert.equal(storedRefreshHash, hashMobileToken(successfulResult.refreshToken));
});

test('Wear refresh returns only the reduced principal', async () => {
  const presentedToken = 'wear-refresh-token';
  let storedRefreshHash;
  const prismaStub = {
    mobileAuthSession: {
      findUnique: async (args) => args.where.refresh_token_hash
        ? { id: 44 }
        : { id: 44, device_platform: 'WEAR_OS', user: baseUser },
      updateMany: async ({ where, data }) => {
        assert.equal(where.refresh_token_hash, storedRefreshHash);
        storedRefreshHash = data.refresh_token_hash;
        return { count: 1 };
      }
    }
  };
  const { hashMobileToken, refreshMobileSession } = loadMobileAuthService({ prismaStub });
  storedRefreshHash = hashMobileToken(presentedToken);
  const result = await refreshMobileSession(presentedToken);

  assert.deepEqual(Object.keys(result.user).sort(), [
    'height_unit', 'id', 'language', 'timezone', 'weight_unit'
  ]);
  assert.equal(result.user.id, baseUser.id);
});

test('mobile auth logout revokes push subscriptions bound to the session', async () => {
  let mobileSessionUpdate = null;
  let pushSubscriptionUpdate = null;
  const prismaStub = {
    $transaction: async (operations) => Promise.all(operations),
    mobileAuthSession: {
      findMany: async () => [{ id: 31 }],
      updateMany: async (args) => {
        mobileSessionUpdate = args;
        return { count: 1 };
      }
    },
    nativePushSubscription: {
      updateMany: async (args) => {
        pushSubscriptionUpdate = args;
        return { count: 1 };
      }
    }
  };

  const { revokeMobileSessionByRefreshToken } = loadMobileAuthService({ prismaStub });
  await revokeMobileSessionByRefreshToken('logout-refresh-token');

  assert.deepEqual(mobileSessionUpdate.where.id, { in: [31] });
  assert.deepEqual(pushSubscriptionUpdate.where.mobile_auth_session_id, { in: [31] });
  assert.equal(mobileSessionUpdate.data.revoked_at, pushSubscriptionUpdate.data.revoked_at);
});

test('mobile auth lists only safe session metadata and marks the current device', async () => {
  const prismaStub = {
    mobileAuthSession: {
      findMany: async () => [{
        id: 44,
        device_id: 'device-44',
        device_platform: 'ANDROID_PHONE',
        device_name: 'Pixel',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        last_used_at: new Date('2026-01-02T00:00:00.000Z'),
        refresh_expires_at: new Date('2026-02-01T00:00:00.000Z')
      }, {
        id: 45,
        device_id: 'wear-45',
        device_platform: 'WEAR_OS',
        device_name: 'Galaxy Watch Ultra',
        created_at: new Date('2026-01-03T00:00:00.000Z'),
        last_used_at: null,
        refresh_expires_at: new Date('2026-02-03T00:00:00.000Z')
      }]
    }
  };

  const { listMobileSessionsForUser } = loadMobileAuthService({ prismaStub });
  const sessions = await listMobileSessionsForUser(7, 44);

  assert.deepEqual(sessions, [{
    id: 44,
    device_id: 'device-44',
    device_platform: 'android_phone',
    device_name: 'Pixel',
    created_at: '2026-01-01T00:00:00.000Z',
    last_used_at: '2026-01-02T00:00:00.000Z',
    refresh_expires_at: '2026-02-01T00:00:00.000Z',
    current: true
  }, {
    id: 45,
    device_id: 'wear-45',
    device_platform: 'wear_os',
    device_name: 'Galaxy Watch Ultra',
    created_at: '2026-01-03T00:00:00.000Z',
    last_used_at: null,
    refresh_expires_at: '2026-02-03T00:00:00.000Z',
    current: false
  }]);
});

test('mobile auth cannot revoke a session owned by another user', async () => {
  let transactionCalled = false;
  const prismaStub = {
    $transaction: async () => {
      transactionCalled = true;
    },
    mobileAuthSession: {
      findFirst: async () => null
    }
  };

  const { revokeMobileSessionForUser } = loadMobileAuthService({ prismaStub });
  const revoked = await revokeMobileSessionForUser(7, 999);

  assert.equal(revoked, false);
  assert.equal(transactionCalled, false);
});

const loginDevice = { deviceId: 'synthetic-phone', devicePlatform: 'ANDROID_PHONE', deviceName: null };

test('verified mobile issuance rejects stale credentials before reading account or creating tokens', async () => {
  let created = false;
  const tx = { user: { updateMany: async ({ where, data }) => {
    assert.deepEqual(where, { id: 4, credential_security_version: 8 });
    assert.deepEqual(data, { credential_security_version: 8 });
    return { count: 0 };
  }, findUnique: async () => { throw Error('must not read stale account'); } },
  mobileAuthSession: { create: async () => { created = true; } } };
  const { issueVerifiedMobileAuthPayload } = loadMobileAuthService({ prismaStub: { $transaction: action => action(tx) } });
  assert.equal(await issueVerifiedMobileAuthPayload({ userId: 4, credentialSecurityVersion: 8, device: loginDevice }), null);
  assert.equal(created, false);
});

test('verified mobile issuance preserves restricted access and returns only after commit', async () => {
  let commit;
  const committed = new Promise(resolve => { commit = resolve; });
  let prepared;
  const preparedSignal = new Promise(resolve => { prepared = resolve; });
  const tx = { user: { updateMany: async () => ({ count: 1 }), findUnique: async () => ({ ...baseUser, email_verified_at: null, legal_acceptances: [] }) },
    mobileAuthSession: { create: async ({ data }) => { assert.equal(data.user_id, 4); return { id: 10 }; } } };
  const { issueVerifiedMobileAuthPayload } = loadMobileAuthService({ prismaStub: { $transaction: async action => {
    const result = await action(tx); prepared(); await committed; return result;
  } } });
  let returned = false;
  const pending = issueVerifiedMobileAuthPayload({ userId: 4, credentialSecurityVersion: 0, device: loginDevice }).then(result => { returned = true; return result; });
  await preparedSignal;
  assert.equal(returned, false);
  commit();
  const payload = await pending;
  assert.equal(payload.user.id, 4);
  assert.equal(payload.user.account_access.state, 'email_verification_required');
  assert.equal('credential_security_version' in payload.user, false);
  assert.equal('password_hash' in payload.user, false);
});

test('verified mobile issuance propagates transaction failure without returning credentials', async () => {
  const { issueVerifiedMobileAuthPayload } = loadMobileAuthService({ prismaStub: { $transaction: async () => { throw Error('synthetic rollback'); } } });
  await assert.rejects(issueVerifiedMobileAuthPayload({ userId: 4, credentialSecurityVersion: 0, device: loginDevice }), /synthetic rollback/);
});
