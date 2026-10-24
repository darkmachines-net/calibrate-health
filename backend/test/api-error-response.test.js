/** @file Regression coverage for api error response: JSON errors receive the additive standard envelope while successful responses remain unchanged. */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  apiRouteNotFoundHandler,
  apiRequestErrorHandler,
  createApiErrorResponseMiddleware
} = require('../src/middleware/apiErrorResponse');
const {
  DiagnosticsRegistry,
  createRequestObservabilityMiddleware
} = require('../src/observability');

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';

async function startTestServer(t) {
  const app = express();
  const replayBody = {
    message: 'Reopen this day before changing its food log.',
    code: 'FOOD_DAY_NOT_OPEN',
    retryable: false,
    food_day: {
      date: '2026-08-08',
      status: 'COMPLETE',
      origin: 'USER',
      source: 'STORED',
      is_representative: true,
      is_complete: true,
      completed_at: '2026-08-08T18:00:00.000Z',
      updated_at: '2026-08-08T18:00:00.000Z'
    },
    field_errors: { food_log_id: ['Food log is required'] }
  };

  app.use(createRequestObservabilityMiddleware({
    config: { enabled: false, metricsEnabled: false, metricsToken: null },
    registry: new DiagnosticsRegistry()
  }));
  app.use(createApiErrorResponseMiddleware());
  app.use(express.json({ limit: '32b' }));

  app.get('/ok', (_req, res) => res.json({ ok: true }));
  app.get('/legacy', (_req, res) => res.status(404).json({ message: 'Food log not found' }));
  app.get('/extended', (_req, res) => res.status(409).json(replayBody));
  app.get('/unavailable', (_req, res) => res.status(503).json({ ok: false }));
  app.get('/malformed', (_req, res) => res.status(422).json({
    message: 73,
    code: '',
    retryable: 'sometimes',
    field_errors: { email: 'Invalid email' }
  }));
  app.get('/unbounded', (_req, res) => res.status(400).json({
    message: 'x'.repeat(513),
    code: `INVALID_${'X'.repeat(96)}`,
    field_errors: Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`field_${index}`, ['Invalid value']])
    ),
    request_payload: { password: 'private' }
  }));
  app.get('/malicious-client', (_req, res) => res.status(400).json({
    message: 'PrismaClientKnownRequestError: SELECT password_hash FROM User',
    code: '',
    retryable: false,
    field_errors: { password: ['password=hunter2'] },
    stack: 'private stack',
    query: { email: 'private@example.com' },
    request_id: 'attacker-controlled'
  }));
  app.get('/malicious-server', (_req, res) => res.status(500).json({
    message: 'Upstream provider response included private payload',
    code: 'DATABASE_FAILURE',
    retryable: false,
    field_errors: { query: ['SELECT * FROM private_table'] },
    stack: 'private stack',
    provider_response: { token: 'private' },
    request_payload: { password: 'private' },
    request_id: 'attacker-controlled'
  }));
  app.get('/disabled', (_req, res) => res.status(503).json({
    message: 'An unsafe replacement message',
    code: 'NATIVE_PUSH_DISABLED',
    retryable: true,
    internal_config: { api_key: 'private' }
  }));
  app.get('/upgrade', (_req, res) => res.status(426).json({
    message: 'Update Calibrate for Android to version 2.3.4 or newer to continue.',
    code: 'CLIENT_UPGRADE_REQUIRED',
    platform: 'android_phone',
    current_version: '2.3.3',
    minimum_supported_version: '2.3.4',
    retryable: false,
    request_payload: { private: true }
  }));
  app.get('/current', (_req, res) => res.status(409).json({
    message: 'Weight changed since the watch snapshot',
    code: 'ENTITY_CONFLICT',
    retryable: false,
    current: {
      local_date: '2026-08-08',
      weight_grams: 81234,
      revision: 'a'.repeat(64),
      private: 'dropped'
    }
  }));
  app.get('/primitive', (_req, res) => res.status(500).json('private upstream response'));
  app.get('/thrown', () => {
    throw Object.assign(new Error('private middleware failure'), { statusCode: 400, expose: false });
  });
  app.get('/thrown-exposed', () => {
    throw Object.assign(new Error('private request payload: password=hunter2'), {
      statusCode: 400,
      expose: true
    });
  });
  app.post('/payload', (_req, res) => res.json({ ok: true }));
  app.use(['/api/v1', '/api', '/auth'], apiRouteNotFoundHandler);
  app.get('/spa-route', (_req, res) => res.type('html').send('<main>SPA</main>'));
  app.use(apiRequestErrorHandler);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    replayBody
  };
}

async function request(origin, path, init = {}) {
  return fetch(`${origin}${path}`, {
    ...init,
    headers: {
      'x-request-id': REQUEST_ID,
      ...init.headers
    }
  });
}

test('JSON errors receive the additive standard envelope while successful responses remain unchanged', async (t) => {
  const { origin } = await startTestServer(t);

  const success = await request(origin, '/ok');
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('x-request-id'), REQUEST_ID);
  assert.deepEqual(await success.json(), { ok: true });

  const legacy = await request(origin, '/legacy');
  assert.equal(legacy.status, 404);
  assert.equal(legacy.headers.get('x-request-id'), REQUEST_ID);
  assert.deepEqual(await legacy.json(), {
    message: 'Food log not found',
    code: 'NOT_FOUND',
    retryable: false,
    request_id: REQUEST_ID
  });

  const unavailable = await request(origin, '/unavailable');
  assert.deepEqual(await unavailable.json(), {
    ok: false,
    message: 'Service unavailable',
    code: 'SERVICE_UNAVAILABLE',
    retryable: true,
    request_id: REQUEST_ID
  });
});

test('explicit error fields and domain extensions are preserved without mutating replay bodies', async (t) => {
  const { origin, replayBody } = await startTestServer(t);
  const originalReplayBody = structuredClone(replayBody);

  const response = await request(origin, '/extended');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ...originalReplayBody,
    request_id: REQUEST_ID
  });
  assert.deepEqual(replayBody, originalReplayBody);
  assert.equal(Object.hasOwn(replayBody, 'request_id'), false);

  const upgrade = await request(origin, '/upgrade');
  assert.deepEqual(await upgrade.json(), {
    platform: 'android_phone',
    current_version: '2.3.3',
    minimum_supported_version: '2.3.4',
    message: 'Update Calibrate for Android to version 2.3.4 or newer to continue.',
    code: 'CLIENT_UPGRADE_REQUIRED',
    retryable: false,
    request_id: REQUEST_ID
  });

  const current = await request(origin, '/current');
  assert.deepEqual(await current.json(), {
    current: {
      local_date: '2026-08-08',
      weight_grams: 81234,
      revision: 'a'.repeat(64)
    },
    message: 'Weight changed since the watch snapshot',
    code: 'ENTITY_CONFLICT',
    retryable: false,
    request_id: REQUEST_ID
  });
});

test('malformed, primitive, and thrown error bodies fall back to safe contract values', async (t) => {
  const { origin } = await startTestServer(t);

  const malformed = await request(origin, '/malformed');
  assert.deepEqual(await malformed.json(), {
    message: 'Invalid request',
    code: 'INVALID_REQUEST',
    retryable: false,
    request_id: REQUEST_ID
  });

  const unbounded = await request(origin, '/unbounded');
  assert.deepEqual(await unbounded.json(), {
    message: 'Invalid request',
    code: 'INVALID_REQUEST',
    retryable: false,
    request_id: REQUEST_ID
  });

  const maliciousClient = await request(origin, '/malicious-client');
  assert.deepEqual(await maliciousClient.json(), {
    message: 'Invalid request',
    code: 'INVALID_REQUEST',
    retryable: false,
    request_id: REQUEST_ID
  });

  const maliciousServer = await request(origin, '/malicious-server');
  assert.deepEqual(await maliciousServer.json(), {
    message: 'Server error',
    code: 'SERVER_ERROR',
    retryable: true,
    request_id: REQUEST_ID
  });

  const disabled = await request(origin, '/disabled');
  assert.deepEqual(await disabled.json(), {
    message: 'Native push is disabled by this server.',
    code: 'NATIVE_PUSH_DISABLED',
    retryable: false,
    request_id: REQUEST_ID
  });

  const primitive = await request(origin, '/primitive');
  assert.deepEqual(await primitive.json(), {
    message: 'Server error',
    code: 'SERVER_ERROR',
    retryable: true,
    request_id: REQUEST_ID
  });

  const thrown = await request(origin, '/thrown');
  assert.deepEqual(await thrown.json(), {
    message: 'Invalid request',
    code: 'INVALID_REQUEST',
    retryable: false,
    request_id: REQUEST_ID
  });

  const thrownExposed = await request(origin, '/thrown-exposed');
  assert.deepEqual(await thrownExposed.json(), {
    message: 'Invalid request',
    code: 'INVALID_REQUEST',
    retryable: false,
    request_id: REQUEST_ID
  });
});

test('unknown API and auth routes return standard JSON before frontend fallback', async (t) => {
  const { origin } = await startTestServer(t);

  for (const path of ['/api/v1/missing', '/api/missing', '/auth/missing']) {
    const response = await request(origin, path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('content-type')?.startsWith('application/json'), true, path);
    assert.equal(response.headers.get('x-request-id'), REQUEST_ID, path);
    assert.deepEqual(await response.json(), {
      message: 'Not found',
      code: 'NOT_FOUND',
      retryable: false,
      request_id: REQUEST_ID
    }, path);
  }

  const spa = await request(origin, '/spa-route');
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /SPA/);
});

test('body-parser syntax errors never expose parser or request text', async (t) => {
  const { origin } = await startTestServer(t);

  const response = await request(origin, '/payload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"private":"sensitive",'
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('x-request-id'), REQUEST_ID);
  assert.deepEqual(await response.json(), {
    message: 'Invalid request',
    code: 'INVALID_REQUEST',
    retryable: false,
    request_id: REQUEST_ID
  });
});

test('body-parser failures use the same request ID in the response header and error body', async (t) => {
  const { origin } = await startTestServer(t);

  const response = await request(origin, '/payload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(100) })
  });
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('x-request-id'), REQUEST_ID);
  assert.deepEqual(await response.json(), {
    message: 'Request body is too large',
    code: 'PAYLOAD_TOO_LARGE',
    retryable: false,
    request_id: REQUEST_ID
  });
});
