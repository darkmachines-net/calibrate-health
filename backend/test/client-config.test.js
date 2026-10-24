/** @file Regression coverage for client config: client config advertises the stable v1 API, release floors, and privacy-safe push default. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { CALIBRATE_HOSTED_ORIGIN } = require('../../shared/product');
const release = require('../../shared/release.json');

const loaded = require('../src/routes/clientConfig');
const router = loaded.default ?? loaded;

function withEnvironment(overrides, task) {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return task();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function readClientConfig() {
  const layer = router.stack.find(
    (candidate) => candidate.route && candidate.route.path === '/' && candidate.route.methods?.get
  );
  assert.ok(layer);
  let body = null;
  const headers = {};
  layer.route.stack[0].handle({}, {
    set: (name, value) => { headers[name.toLowerCase()] = value; },
    json: (payload) => { body = payload; }
  });
  return { body, headers };
}

test('client config advertises the stable v1 API, release floors, and privacy-safe push default', () => {
  withEnvironment({
    NATIVE_PUSH_MODE: undefined,
    WEB_PUSH_PUBLIC_KEY: undefined,
    WEB_PUSH_PRIVATE_KEY: undefined,
    WEB_PUSH_SUBJECT: undefined
  }, () => {
    const { body, headers } = readClientConfig();

    assert.equal(body.api_version, 1);
    assert.equal(body.api_versions.current, 'v1');
    assert.equal(body.server_version, release.server.version);
    assert.equal(headers['cache-control'], 'no-store');
    assert.deepEqual(body.api_versions.supported, ['v1']);
    assert.equal(body.api_versions.legacy_alias, '/api');
    assert.equal(body.hosted_origin, CALIBRATE_HOSTED_ORIGIN);
    assert.equal(body.min_supported_mobile_version, '0.1.0');
    assert.equal(body.min_supported_wear_version, '0.2.0');
    assert.equal(body.capabilities.native_push, false);
    assert.equal(body.capabilities.self_hosted_server_url, true);
    assert.equal(body.capabilities.web_push, false);
    assert.equal(body.capabilities.wear_os_ready, true);
    assert.match(body.api_versions.legacy_deprecation, /migrated/i);
  });
});

test('client config advertises browser push only with complete VAPID configuration', () => {
  withEnvironment({
    WEB_PUSH_PUBLIC_KEY: 'public-key',
    WEB_PUSH_PRIVATE_KEY: 'private-key',
    WEB_PUSH_SUBJECT: 'mailto:operator@example.com'
  }, () => {
    const { body } = readClientConfig();
    assert.equal(body.capabilities.web_push, true);
  });
});

test('client config advertises native push only after the operator enables Expo mode', () => {
  withEnvironment({ NATIVE_PUSH_MODE: 'expo' }, () => {
    const { body } = readClientConfig();
    assert.equal(body.capabilities.native_push, true);
  });
});

test('client config ignores an injected package version in favor of the canonical manifest', () => {
  withEnvironment({ npm_package_version: '99.99.99' }, () => {
    const { body } = readClientConfig();
    assert.equal(body.server_version, release.server.version);
  });
});
