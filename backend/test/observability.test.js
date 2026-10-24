/** @file Regression coverage for observability: request observability emits bounded metadata without URL, query, headers, identity, or health payloads. */

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  DiagnosticsRegistry,
  classifyDiagnosticCategory,
  createDiagnosticsMetricsHandler,
  createRequestObservabilityMiddleware,
  diagnosticOperationOutcomeForStatus,
  emitDiagnosticEvent,
  resolveObservabilityConfig,
  logSafeOperationalError,
  safeErrorType,
  safeRequestId,
  sanitizeDiagnosticFields
} = require('../src/observability');

function mockResponse(statusCode = 200) {
  const response = new EventEmitter();
  response.locals = {};
  response.statusCode = statusCode;
  response.headers = new Map();
  response.setHeader = (name, value) => response.headers.set(name.toLowerCase(), value);
  response.status = (value) => { response.statusCode = value; return response; };
  response.json = (value) => { response.body = value; return response; };
  return response;
}

test('request observability emits bounded metadata without URL, query, headers, identity, or health payloads', () => {
  const registry = new DiagnosticsRegistry();
  const lines = [];
  const times = [1_000_000_000n, 1_125_000_000n];
  const middleware = createRequestObservabilityMiddleware({
    config: { enabled: true, metricsEnabled: false, metricsToken: null },
    registry,
    nowNs: () => times.shift(),
    write: (line) => lines.push(line)
  });
  const headers = {
    'x-request-id': '123e4567-e89b-42d3-a456-426614174000',
    authorization: 'Bearer secret-token',
    cookie: 'cal.sid=secret'
  };
  const request = {
    method: 'POST',
    originalUrl: '/api/v1/watch/mutations?weight_grams=81234&food=private',
    url: '/api/v1/watch/mutations',
    body: { weight_grams: 81234 },
    get: (name) => headers[name.toLowerCase()]
  };
  const response = mockResponse(409);

  let nextCalled = false;
  middleware(request, response, () => { nextCalled = true; });
  response.emit('finish');

  assert.equal(nextCalled, true);
  assert.equal(response.headers.get('x-request-id'), '123e4567-e89b-42d3-a456-426614174000');
  const event = JSON.parse(lines[0]);
  assert.deepEqual(
    Object.keys(event).sort(),
    ['category', 'correlation_id', 'duration_ms', 'event', 'level', 'method', 'outcome', 'request_id', 'service', 'status_code', 'timestamp'].sort()
  );
  assert.equal(event.category, 'watch_reconciliation');
  assert.equal(event.duration_ms, 125);
  assert.equal(event.status_code, 409);
  assert.equal(lines[0].includes('81234'), false);
  assert.equal(lines[0].includes('secret-token'), false);
  assert.equal(lines[0].includes('private'), false);
  assert.equal(registry.snapshot().requests.by_category.watch_reconciliation.failures, 1);
});

test('request IDs, categories, and diagnostic fields are validated and redacted', () => {
  assert.equal(safeRequestId(' 0123456789abcdef ', () => 'fallback'), '0123456789abcdef');
  assert.equal(safeRequestId('bad id', () => 'fallback'), 'fallback');
  assert.equal(safeRequestId('myweight81234private', () => 'fallback'), 'fallback');
  assert.equal(classifyDiagnosticCategory('/auth/mobile/login'), 'auth');
  assert.equal(classifyDiagnosticCategory('/api/v1/food/search?q=oats'), 'provider');
  assert.equal(classifyDiagnosticCategory('/api/sync?cursor=private'), 'sync');
  assert.deepEqual(sanitizeDiagnosticFields({
    outcome: 'success',
    access_token: 'secret',
    weight_grams: 81234,
    invalidKey: 'dropped'
  }), {
    outcome: 'success',
    access_token: '[REDACTED]',
    weight_grams: '[REDACTED]'
  });
});

test('operational errors omit messages, stacks, and unsafe caller-controlled names', () => {
  const lines = [];
  const error = new Error('password=hunter2 token=private weight=81234');
  error.name = 'Error\npassword=hunter2';
  logSafeOperationalError(
    'auth.mobile_login',
    error,
    '123e4567-e89b-42d3-a456-426614174000',
    (line) => lines.push(line)
  );
  assert.equal(safeErrorType(error), 'UnknownError');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /auth\.mobile_login failed/);
  assert.equal(lines[0].includes('hunter2'), false);
  assert.equal(lines[0].includes('81234'), false);
});

test('metrics surface is opt-in, bearer protected, and contains only bounded aggregate counters', () => {
  const token = 'a'.repeat(32);
  const config = resolveObservabilityConfig({
    CALIBRATE_DIAGNOSTICS_ENABLED: 'true',
    CALIBRATE_DIAGNOSTICS_METRICS_TOKEN: token
  });
  const registry = new DiagnosticsRegistry();
  registry.recordRequest('auth', 401, 25);
  registry.recordRequest('provider', 503, 250);
  registry.recordJob('reminder_scheduler', 'failure', 500);
  registry.recordOperation('notification_delivery', 'failure');
  registry.recordOperation('food_provider_request', 'failure', 250);
  registry.recordOperation('food_provider_request', 'empty', 125);
  registry.recordOperation('health_connect_ingestion', 'conflict', Number.POSITIVE_INFINITY);
  const handler = createDiagnosticsMetricsHandler({ config, registry });

  const unauthorized = mockResponse();
  handler({ get: () => 'Bearer wrong' }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const authorized = mockResponse();
  handler({ get: (name) => name === 'authorization' ? `Bearer ${token}` : undefined }, authorized);
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.headers.get('cache-control'), 'no-store');
  assert.equal(authorized.body.requests.total, 2);
  assert.equal(authorized.body.requests.serverFailures, 1);
  assert.equal(authorized.body.background_jobs.reminder_scheduler.failures, 1);
  assert.equal(authorized.body.operations.notification_delivery.attempts, 1);
  assert.equal(authorized.body.operations.notification_delivery.failures, 1);
  assert.equal(authorized.body.operations.notification_delivery.durationSamples, 0);
  assert.equal(authorized.body.operations.notification_delivery.latencyBuckets.up_to_10, 0);
  assert.equal(authorized.body.operations.food_provider_request.failures, 1);
  assert.equal(authorized.body.operations.food_provider_request.empty, 1);
  assert.equal(authorized.body.operations.food_provider_request.durationSamples, 2);
  assert.equal(authorized.body.operations.food_provider_request.durationMsTotal, 375);
  assert.equal(authorized.body.operations.food_provider_request.latencyBuckets.up_to_500, 2);
  assert.equal(authorized.body.operations.health_connect_ingestion.conflicts, 1);
  assert.equal(authorized.body.operations.health_connect_ingestion.durationMsTotal, 0);
  const encoded = JSON.stringify(authorized.body);
  assert.equal(encoded.includes(token), false);
  assert.equal(encoded.includes('user'), false);

  const disabled = mockResponse();
  createDiagnosticsMetricsHandler({
    config: { enabled: false, metricsEnabled: false, metricsToken: null },
    registry
  })({ get: () => undefined }, disabled);
  assert.equal(disabled.statusCode, 404);
});

test('operation status mapping uses a fixed bounded outcome vocabulary', () => {
  assert.equal(diagnosticOperationOutcomeForStatus(200), 'success');
  assert.equal(diagnosticOperationOutcomeForStatus(304), 'success');
  assert.equal(diagnosticOperationOutcomeForStatus(400), 'rejected');
  assert.equal(diagnosticOperationOutcomeForStatus(409), 'conflict');
  assert.equal(diagnosticOperationOutcomeForStatus(503), 'failure');
});
test('scheduler metrics keep lastSuccessAt pinned across later failed and skipped runs', () => {
  const registry = new DiagnosticsRegistry();
  registry.recordJob('reminder_scheduler', 'success', 10);
  const successful = registry.snapshot().background_jobs.reminder_scheduler;
  assert.match(successful.lastSuccessAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(successful.lastSuccessAt, successful.lastFinishedAt);

  registry.recordJob('reminder_scheduler', 'failure', 20);
  registry.recordJob('reminder_scheduler', 'skipped', 0);
  const afterNonSuccess = registry.snapshot().background_jobs.reminder_scheduler;
  assert.equal(afterNonSuccess.lastSuccessAt, successful.lastSuccessAt);
  assert.equal(afterNonSuccess.lastOutcome, 'skipped');
  assert.equal(afterNonSuccess.successes, 1);
  assert.equal(afterNonSuccess.failures, 1);
  assert.equal(afterNonSuccess.skipped, 1);
});
test('maps generated error names to closed categories and keeps sensitive values out of emitted JSON and metrics', () => {
  let seed = 0x301cafe;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed;
  };
  const registry = new DiagnosticsRegistry();
  const emitted = [];
  const opaqueIds = [];

  for (let index = 0; index < 256; index += 1) {
    const sensitiveName = 'AliceWeight' + random().toString(16);
    const sensitiveValue = 'person' + index + '@example.invalid token=' + random().toString(16) + ' weight=' + (80000 + index);
    const error = new Error(sensitiveValue);
    error.name = sensitiveName;
    error.stack = 'private-stack-' + sensitiveValue;

    assert.equal(safeErrorType(error), 'UnknownError');
    emitDiagnosticEvent(
      { enabled: true, metricsEnabled: false, metricsToken: null },
      'property.error',
      {
        error_type: error.name,
        message: error.message,
        stack: error.stack,
        url: 'https://private.invalid/' + sensitiveValue,
      },
      (line) => emitted.push(line)
    );
    const requestId = random().toString(16).padStart(16, '0');
    opaqueIds.push(requestId);
    registry.recordClientDiagnostic({
      event: 'client_failure',
      operation: 'root_render',
      route: 'app_shell',
      platform: 'web',
      version: '0.14.0',
      outcome: 'failure',
      duration_bucket: 'not_applicable',
      request_id: requestId
    });
  }

  const encodedEvents = emitted.join('\n');
  assert.equal(emitted.length, 256);
  assert.equal(encodedEvents.includes('AliceWeight'), false);
  assert.equal(encodedEvents.includes('example.invalid'), false);
  assert.equal(encodedEvents.includes('private-stack'), false);
  for (const line of emitted) {
    const event = JSON.parse(line);
    assert.equal(event.error_type, 'UnknownError');
    assert.equal(event.message, '[REDACTED]');
    assert.equal(event.stack, '[REDACTED]');
    assert.equal(event.url, '[REDACTED]');
  }

  const encodedMetrics = JSON.stringify(registry.snapshot());
  assert.equal(encodedMetrics.includes('request_id'), false);
  for (const requestId of opaqueIds) assert.equal(encodedMetrics.includes(requestId), false);
  assert.equal(registry.snapshot().client_diagnostics.total, 256);
});
