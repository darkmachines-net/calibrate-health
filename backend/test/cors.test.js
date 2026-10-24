/** @file Regression coverage for cors: development permits loopback web dev servers on arbitrary ports despite an explicit configured origin. */

const test = require('node:test');
const assert = require('node:assert/strict');
const cors = require('cors');
const express = require('express');

const {
  isDevelopmentLoopbackOrigin,
  isOriginTrustedByPolicy,
  resolveBrowserOriginPolicy
} = require('../src/config/cors');
const { isProductionOrStagingEnv } = require('../src/config/environment');
const { createCorsOptionsDelegate } = require('../src/middleware/cors');

async function startCorsTestServer(t, configuredOrigins, nodeEnv) {
  const isProductionOrStaging = isProductionOrStagingEnv(nodeEnv);
  const app = express();
  app.use(cors(createCorsOptionsDelegate({
    originPolicy: resolveBrowserOriginPolicy(configuredOrigins, isProductionOrStaging),
    isProductionOrStaging,
    useSecureRequestOrigin: false
  })));
  app.get('/config', (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.statusCode ?? 500).json({ message: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}/config`;
}

test('development permits loopback web dev servers on arbitrary ports despite an explicit configured origin', () => {
  const policy = resolveBrowserOriginPolicy('http://localhost:8081', false);

  for (const origin of [
    'http://localhost:8081',
    'http://127.0.0.1:19006',
    'http://[::1]:4174'
  ]) {
    assert.equal(isOriginTrustedByPolicy(origin, policy), true, origin);
  }
});

test('development loopback matching rejects non-local and lookalike origins', () => {
  for (const origin of [
    'http://example.com:8081',
    'http://localhost.example.com:8081',
    'http://192.168.1.20:8081',
    'ftp://localhost:8081',
    'not-an-origin'
  ]) {
    assert.equal(isDevelopmentLoopbackOrigin(origin), false, origin);
  }
});

test('production and staging keep strict exact-origin allowlisting', () => {
  for (const nodeEnv of ['production', 'staging']) {
    const policy = resolveBrowserOriginPolicy(
      'http://localhost:8081,https://app.calibratehealth.example',
      isProductionOrStagingEnv(nodeEnv)
    );

    assert.equal(isOriginTrustedByPolicy('http://localhost:8081', policy), true, nodeEnv);
    assert.equal(isOriginTrustedByPolicy('https://app.calibratehealth.example', policy), true, nodeEnv);
    assert.equal(isOriginTrustedByPolicy('http://localhost:19006', policy), false, nodeEnv);
    assert.equal(isOriginTrustedByPolicy('http://127.0.0.1:8081', policy), false, nodeEnv);
    assert.equal(isOriginTrustedByPolicy('https://untrusted.example', policy), false, nodeEnv);
  }
});

test('CORS middleware emits headers for Expo origins while rejecting non-local origins', async (t) => {
  const url = await startCorsTestServer(t, 'http://localhost:8081', 'development');

  for (const origin of ['http://localhost:8081', 'http://127.0.0.1:19006', 'http://[::1]:4174']) {
    const response = await fetch(url, { headers: { origin } });
    assert.equal(response.status, 200, origin);
    assert.equal(response.headers.get('access-control-allow-origin'), origin, origin);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true', origin);
    assert.equal(response.headers.get('access-control-expose-headers'), 'x-request-id', origin);
  }

  const rejected = await fetch(url, { headers: { origin: 'http://untrusted.example:8081' } });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
});

test('CORS middleware does not broaden an exact production origin to other local ports', async (t) => {
  const url = await startCorsTestServer(t, 'http://localhost:8081', 'production');

  const exact = await fetch(url, { headers: { origin: 'http://localhost:8081' } });
  assert.equal(exact.status, 200);
  assert.equal(exact.headers.get('access-control-allow-origin'), 'http://localhost:8081');

  const alternatePort = await fetch(url, { headers: { origin: 'http://localhost:19006' } });
  assert.equal(alternatePort.status, 403);
  assert.equal(alternatePort.headers.get('access-control-allow-origin'), null);
});
