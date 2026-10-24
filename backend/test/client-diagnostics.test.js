/** @file Regression coverage for client diagnostics: strict parser accepts only canonical coherent registry tuples. */

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const release = require('../../shared/release.json');
const diagnosticVersions = require('../../shared/client-diagnostic-versions.json');
const { NATIVE_CLIENT_HEADERS } = require('../../shared/clientCompatibility');
const { DiagnosticsRegistry, sanitizeDiagnosticFields } = require('../src/observability');
const { createClientDiagnosticsHandler } = require('../src/routes/clientDiagnostics');
const { parseClientDiagnosticInput } = require('../src/services/clientDiagnostics');
const { createClientDiagnosticsRateLimiter } = require('../src/middleware/security');
const { enforceNativeClientCompatibility } = require('../src/middleware/clientCompatibility');

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const CLIENT_REQUEST_ID = '11111111-1111-4111-8111-111111111111';

const basePayload = {
  event: 'web_vital',
  operation: 'interaction_to_next_paint',
  route: 'today',
  platform: 'web',
  version: release.server.version,
  outcome: 'needs_improvement',
  duration_bucket: '200_to_500_ms'
};

function mockResponse(locals = {}) {
  return {
    locals,
    headers: new Map(),
    statusCode: 200,
    setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

function mockRequest(body, headers = {}, user) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  return { body, user, get: (name) => normalized[name.toLowerCase()] };
}

test('strict parser accepts only canonical coherent registry tuples', () => {
  const valid = [
    {
      event: 'client_failure', operation: 'root_render', route: 'app_shell', platform: 'web',
      version: release.server.version, outcome: 'failure', duration_bucket: 'not_applicable'
    },
    {
      event: 'operation_failure', operation: 'onboarding_complete', route: 'onboarding',
      platform: 'android_phone', version: release.android.mobile.version_name,
      outcome: 'failure', duration_bucket: 'not_applicable'
    },
    {
      event: 'degraded_result', operation: 'weight_trend_load', route: 'progress', platform: 'wear_os',
      version: release.android.wear.version_name, outcome: 'degraded', duration_bucket: 'not_applicable'
    },
    {
      ...basePayload, operation: 'largest_contentful_paint', outcome: 'good', duration_bucket: '1_to_2_5_s'
    },
    {
      ...basePayload, operation: 'largest_contentful_paint', outcome: 'poor', duration_bucket: '4_s_or_more'
    },
    { ...basePayload, outcome: 'good', duration_bucket: '100_to_200_ms' },
    { ...basePayload, outcome: 'poor', duration_bucket: '500_ms_to_1_s' },
    {
      ...basePayload, operation: 'cumulative_layout_shift', outcome: 'good',
      duration_bucket: 'not_applicable'
    }
  ];

  for (const payload of valid) assert.equal(parseClientDiagnosticInput(payload).ok, true);
  for (const version of diagnosticVersions.supported_versions.web) {
    assert.equal(parseClientDiagnosticInput({ ...basePayload, version }).ok, true, `web ${version}`);
  }
  for (const version of diagnosticVersions.supported_versions.android_phone) {
    assert.equal(parseClientDiagnosticInput({
      event: 'operation_failure', operation: 'saved_foods_load', route: 'saved_foods',
      platform: 'android_phone', version, outcome: 'failure', duration_bucket: 'not_applicable'
    }).ok, true, `android_phone ${version}`);
  }
  for (const version of diagnosticVersions.supported_versions.ios) {
    assert.equal(parseClientDiagnosticInput({
      event: 'operation_failure', operation: 'saved_foods_load', route: 'saved_foods',
      platform: 'ios', version, outcome: 'failure', duration_bucket: 'not_applicable'
    }).ok, true, `ios ${version}`);
  }
  for (const version of diagnosticVersions.supported_versions.wear_os) {
    assert.equal(parseClientDiagnosticInput({
      event: 'degraded_result', operation: 'weight_trend_load', route: 'progress',
      platform: 'wear_os', version, outcome: 'degraded', duration_bucket: 'not_applicable'
    }).ok, true, `wear_os ${version}`);
  }

  const invalid = [
    { ...basePayload, outcome: 'good' },
    { ...basePayload, operation: 'largest_contentful_paint', outcome: 'poor', duration_bucket: 'under_100_ms' },
    { ...basePayload, operation: 'cumulative_layout_shift', duration_bucket: 'under_100_ms' },
    { ...basePayload, platform: 'android_phone', version: release.android.mobile.version_name },
    { ...basePayload, event: 'operation_failure', operation: 'food_copy', route: 'saved_foods', outcome: 'failure', duration_bucket: 'not_applicable' },
    { ...basePayload, version: '0.14.0-private-build' },
    { ...basePayload, version: '0.13.1' },
    { ...basePayload, duration_bucket: '100_to_300_ms' },
    { ...basePayload, request_id: 'user@example.com?token=private' }
  ];
  for (const payload of invalid) assert.equal(parseClientDiagnosticInput(payload).ok, false);
});

test('handler correlates opaque IDs and records only fixed joint dimensions', () => {
  const registry = new DiagnosticsRegistry();
  const lines = [];
  const handler = createClientDiagnosticsHandler({
    config: { enabled: true, metricsEnabled: false, metricsToken: null },
    registry,
    write: (line) => lines.push(line)
  });
  const response = mockResponse({ requestId: REQUEST_ID });

  handler(mockRequest({ ...basePayload, request_id: CLIENT_REQUEST_ID }, {}, { id: 7 }), response);

  assert.equal(response.statusCode, 202);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-request-id'), REQUEST_ID);
  assert.deepEqual(response.body, { ok: true, request_id: REQUEST_ID });
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(logged).sort(), [
    'diagnostic_event', 'duration_bucket', 'event', 'level', 'operation', 'outcome',
    'platform', 'request_id', 'route', 'service', 'timestamp', 'version'
  ].sort());
  assert.equal(logged.request_id, CLIENT_REQUEST_ID);

  const snapshot = registry.snapshot();
  assert.equal(snapshot.client_diagnostics.total, 1);
  assert.deepEqual(snapshot.client_diagnostics.by_tuple, [{ ...basePayload, count: 1 }]);
  const encoded = JSON.stringify(snapshot.client_diagnostics);
  assert.equal(encoded.includes(CLIENT_REQUEST_ID), false);
  assert.equal(encoded.includes(REQUEST_ID), false);
});

test('unknown and private fields are rejected before logging or aggregation', () => {
  const privateFields = ['message', 'stack', 'url', 'query', 'payload', 'body', 'detail'];
  for (const key of privateFields) {
    const registry = new DiagnosticsRegistry();
    const lines = [];
    const handler = createClientDiagnosticsHandler({
      config: { enabled: true, metricsEnabled: false, metricsToken: null },
      registry,
      write: (line) => lines.push(line)
    });
    const response = mockResponse({ requestId: REQUEST_ID });
    handler(mockRequest({ ...basePayload, [key]: 'email=user@example.com&token=private' }), response);
    assert.equal(response.statusCode, 400, key);
    assert.equal(response.headers.get('cache-control'), 'no-store', key);
    assert.deepEqual(response.body, { message: 'Invalid client diagnostic payload' }, key);
    assert.equal(lines.length, 0, key);
    assert.equal(registry.snapshot().client_diagnostics.total, 0, key);
  }
});

test('cookie sessions cannot forge native diagnostics while bearer-established native identity is accepted', async (t) => {
  const registry = new DiagnosticsRegistry();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 7 };
    if (req.get('x-test-principal') === 'bearer') {
      res.locals.mobileDevicePlatform = 'android_phone';
    }
    next();
  });
  app.use(enforceNativeClientCompatibility);
  app.post('/api/v1/client-diagnostics', createClientDiagnosticsHandler({
    config: { enabled: false, metricsEnabled: false, metricsToken: null },
    registry
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const payload = {
    event: 'operation_failure', operation: 'saved_foods_load', route: 'saved_foods',
    platform: 'android_phone', version: release.android.mobile.version_name,
    outcome: 'failure', duration_bucket: 'not_applicable'
  };
  const send = (principal) => fetch(`http://127.0.0.1:${address.port}/api/v1/client-diagnostics`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-principal': principal,
      [NATIVE_CLIENT_HEADERS.PLATFORM]: 'android_phone',
      [NATIVE_CLIENT_HEADERS.VERSION]: release.android.mobile.version_name
    },
    body: JSON.stringify(payload)
  });

  const cookieSpoof = await send('cookie');
  assert.equal(cookieSpoof.status, 400);
  assert.deepEqual(await cookieSpoof.json(), { message: 'Invalid client diagnostic payload' });
  assert.equal(registry.snapshot().client_diagnostics.total, 0);

  const nativeBearer = await send('bearer');
  assert.equal(nativeBearer.status, 202);
  assert.equal(registry.snapshot().client_diagnostics.total, 1);
});

test('generic diagnostic sanitizer keeps only closed safe fields and drops alias strings', () => {
  assert.deepEqual(sanitizeDiagnosticFields({
    error_type: 'TypeError',
    environment: 'staging',
    detail: 'secret123',
    label: 'user@example.com',
    message: 'password=hunter2',
    stack: 'private stack',
    url: 'https://example.test/?token=private',
    route: '/users/81234',
    request_id: 'not opaque private'
  }), {
    error_type: 'TypeError',
    environment: 'staging',
    message: '[REDACTED]',
    stack: '[REDACTED]',
    url: '[REDACTED]',
    route: '[REDACTED]',
    request_id: '[REDACTED]'
  });
});

test('diagnostics aliases share a narrow IP limit even when unauthenticated tuples are rejected', async (t) => {
  const app = express();
  app.use(express.json());
  const limiter = createClientDiagnosticsRateLimiter({ windowMs: 60_000, limit: 2 });
  const handler = createClientDiagnosticsHandler({
    config: { enabled: false, metricsEnabled: false, metricsToken: null }
  });
  app.post(['/api/v1/client-diagnostics', '/api/client-diagnostics'], limiter, handler);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const send = (path) => fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(basePayload)
  });

  assert.equal((await send('/api/v1/client-diagnostics')).status, 401);
  assert.equal((await send('/api/client-diagnostics')).status, 401);
  const limited = await send('/api/v1/client-diagnostics');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await limited.json(), { message: 'Too many client diagnostics. Try again later.' });
});
test('requires authentication outside anonymous root support while preserving opaque root correlation', () => {
  const registry = new DiagnosticsRegistry();
  const lines = [];
  const handler = createClientDiagnosticsHandler({
    config: { enabled: true, metricsEnabled: false, metricsToken: null },
    registry,
    write: (line) => lines.push(JSON.parse(line))
  });

  const anonymousVital = mockResponse({ requestId: REQUEST_ID });
  handler(mockRequest({ ...basePayload, request_id: CLIENT_REQUEST_ID }), anonymousVital);
  assert.equal(anonymousVital.statusCode, 401);
  assert.equal(anonymousVital.headers.get('cache-control'), 'no-store');
  assert.deepEqual(anonymousVital.body, { message: 'Not authenticated' });
  assert.equal(registry.snapshot().client_diagnostics.total, 0);
  assert.equal(lines.length, 0);

  const rootRequestId = '44444444-4444-4444-8444-444444444444';
  const anonymousRoot = mockResponse({ requestId: REQUEST_ID });
  handler(mockRequest({
    event: 'client_failure',
    operation: 'root_render',
    route: 'app_shell',
    platform: 'web',
    version: release.server.version,
    outcome: 'failure',
    duration_bucket: 'not_applicable',
    request_id: rootRequestId
  }), anonymousRoot);
  assert.equal(anonymousRoot.statusCode, 202);
  assert.equal(registry.snapshot().client_diagnostics.total, 1);
  assert.equal(lines[0].request_id, rootRequestId);

  const authenticatedVital = mockResponse({ requestId: REQUEST_ID });
  handler(mockRequest(basePayload, {}, { id: 7 }), authenticatedVital);
  assert.equal(authenticatedVital.statusCode, 202);
  const snapshot = registry.snapshot().client_diagnostics;
  assert.equal(snapshot.total, 2);
  assert.equal(lines.length, 2);
  assert.equal(snapshot.by_tuple.some((tuple) => tuple.operation === 'interaction_to_next_paint'), true);
});
test('rejects generated sensitive aliases and values before logging or metrics export', () => {
  let seed = 0x3015afe;
  const random = () => {
    seed = (1103515245 * seed + 12345) >>> 0;
    return seed;
  };
  const roots = [
    'authorization', 'cookie', 'token', 'secret', 'password', 'email', 'user_id',
    'payload', 'query', 'body', 'food', 'weight', 'calorie', 'barcode', 'message',
    'stack', 'url', 'path', 'exception'
  ];
  const registry = new DiagnosticsRegistry();
  const lines = [];
  const responses = [];
  const handler = createClientDiagnosticsHandler({
    config: { enabled: true, metricsEnabled: false, metricsToken: null },
    registry,
    write: (line) => lines.push(line)
  });

  for (let index = 0; index < 256; index += 1) {
    const root = roots[index % roots.length];
    const alias = root + '_alias_' + random().toString(16);
    const sensitiveValue = 'person' + index + '@example.invalid?token=' + random().toString(16) + '&weight=' + (81000 + index);
    const response = mockResponse({ requestId: REQUEST_ID });
    handler(mockRequest({ ...basePayload, [alias]: sensitiveValue }, {}, { id: 7 }), response);
    assert.equal(response.statusCode, 400);
    responses.push(JSON.stringify(response.body));
  }

  assert.equal(lines.length, 0);
  assert.equal(registry.snapshot().client_diagnostics.total, 0);
  const exported = JSON.stringify({ responses, metrics: registry.snapshot() });
  assert.equal(exported.includes('example.invalid'), false);
  assert.equal(exported.includes('token='), false);
  assert.equal(exported.includes('weight='), false);
  for (const root of roots) assert.equal(exported.includes(root + '_alias_'), false);
});
