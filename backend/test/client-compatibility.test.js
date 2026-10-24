/** @file Regression coverage for client compatibility: browser requests without native identity remain compatible. */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  enforceNativeClientCompatibility
} = require('../src/middleware/clientCompatibility');

function createRequest({ path = '/api/v1/food', headers = {} } = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return {
    path,
    get(name) {
      return normalized[name.toLowerCase()];
    }
  };
}

function createResponse(locals = {}) {
  return {
    locals,
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function run(options = {}, locals = {}) {
  const req = createRequest(options);
  const res = createResponse(locals);
  let nextCount = 0;
  enforceNativeClientCompatibility(req, res, () => { nextCount += 1; });
  return { nextCount, req, res };
}

test('browser requests without native identity remain compatible', () => {
  const { nextCount, res } = run();
  assert.equal(nextCount, 1);
  assert.equal(res.statusCode, 200);
});

test('authenticated phone sessions require a current bounded version on every request', () => {
  const missing = run({}, { mobileDevicePlatform: 'android_phone' });
  assert.equal(missing.nextCount, 0);
  assert.equal(missing.res.statusCode, 426);
  assert.equal(missing.res.body.code, 'CLIENT_UPGRADE_REQUIRED');
  assert.equal(missing.res.body.current_version, null);
  assert.equal(missing.res.body.minimum_supported_version, '0.1.0');

  const current = run({
    headers: {
      'x-calibrate-client-platform': 'android_phone',
      'x-calibrate-client-version': '0.1.0-internal'
    }
  }, { mobileDevicePlatform: 'android_phone' });
  assert.equal(current.nextCount, 1);
  assert.equal(current.res.locals.nativeClientVersion, '0.1.0-internal');
});

test('authenticated iOS sessions use the mobile release floor and iOS upgrade copy', () => {
  const missing = run({}, { mobileDevicePlatform: 'ios' });
  assert.equal(missing.nextCount, 0);
  assert.equal(missing.res.statusCode, 426);
  assert.equal(missing.res.body.platform, 'ios');
  assert.match(missing.res.body.message, /Calibrate for iOS/);

  const current = run({
    headers: {
      'x-calibrate-client-platform': 'ios',
      'x-calibrate-client-version': '0.1.0-internal'
    }
  }, { mobileDevicePlatform: 'ios' });
  assert.equal(current.nextCount, 1);
  assert.equal(current.res.locals.nativeClientVersion, '0.1.0-internal');
});

test('authenticated session platform cannot be changed by client headers', () => {
  const { nextCount, res } = run({
    headers: {
      'x-calibrate-client-platform': 'wear_os',
      'x-calibrate-client-version': '99.0.0'
    }
  }, { mobileDevicePlatform: 'android_phone' });
  assert.equal(nextCount, 0);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'CLIENT_PLATFORM_MISMATCH');
});

test('Wear pairing exchange requires Wear version identity before issuing a session', () => {
  const missing = run({ path: '/api/v1/auth/mobile/wear/pair' });
  assert.equal(missing.nextCount, 0);
  assert.equal(missing.res.statusCode, 426);
  assert.equal(missing.res.body.platform, 'wear_os');

  const current = run({
    path: '/api/v1/auth/mobile/wear/pair',
    headers: {
      'x-calibrate-client-platform': 'wear_os',
      'x-calibrate-client-version': '0.2.0-internal'
    }
  });
  assert.equal(current.nextCount, 1);

  const older = run({
    path: '/api/v1/auth/mobile/wear/pair',
    headers: {
      'x-calibrate-client-platform': 'wear_os',
      'x-calibrate-client-version': '0.1.0'
    }
  });
  assert.equal(older.nextCount, 0);
  assert.equal(older.res.statusCode, 426);
  assert.equal(older.res.headers['x-calibrate-minimum-client-version'], '0.2.0');
});

test('older and malformed versions receive a bounded upgrade contract', () => {
  for (const version of ['0.0.9', 'future', '1.2', '1.2.3.4', '9'.repeat(80)]) {
    const { nextCount, res } = run({
      headers: {
        'x-calibrate-client-platform': 'android_phone',
        'x-calibrate-client-version': version
      }
    });
    assert.equal(nextCount, 0, version);
    assert.equal(res.statusCode, 426, version);
    assert.equal(res.body.retryable, false, version);
    assert.equal(res.headers['x-calibrate-minimum-client-version'], '0.1.0', version);
  }
});
