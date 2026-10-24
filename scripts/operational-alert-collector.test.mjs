/** @file Regression coverage for operational alert collector: collector failure output never includes generated paths or malformed response contents. */

import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireCollectorLock,
  atomicWriteCollectorState,
  collectOperationalAlertsOnce,
  collectorFailureLine,
  createHttpAlertSink,
  releaseCollectorLock,
  runSyntheticStagingSmoke,
  sanitizeMetricsSnapshot,
} from './operational-alert-collector.mjs';

const PROCESS_STARTED_AT = '2026-08-09T10:00:00.000Z';

function metricsSnapshot(operations = {}, lastSuccessAt = '2026-08-09T11:55:00.000Z') {
  return {
    process_started_at: PROCESS_STARTED_AT,
    requests: { total: 0, serverFailures: 0, by_category: { auth: { total: 0, serverFailures: 0 } } },
    operations,
    client_diagnostics: { by_tuple: [] },
    background_jobs: { reminder_scheduler: { lastSuccessAt } },
  };
}

function fixtureFetch(snapshots, observedServerVersion = '0.14.0') {
  return async (url, init) => {
    if (String(url).endsWith('/internal/diagnostics/metrics')) {
      assert.equal(init.headers.authorization, 'Bearer metrics-token-12345678901234567890');
      return new Response(JSON.stringify(snapshots.shift()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    assert.equal(String(url), 'https://staging.example.invalid/api/v1/client-config');
    return new Response(JSON.stringify({ server_version: observedServerVersion }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function collectorInput(statePath, sink, fetchImpl, now) {
  return {
    metricsUrl: 'https://staging.example.invalid/internal/diagnostics/metrics',
    metricsToken: 'metrics-token-12345678901234567890',
    clientConfigUrl: 'https://staging.example.invalid/api/v1/client-config',
    expectedServerVersion: '0.14.0',
    reminderIntervalMs: 15 * 60 * 1000,
    statePath,
    sink,
    fetchImpl,
    now,
  };
}

test('collector failure output never includes generated paths or malformed response contents', () => {
  let seed = 0x301c011;
  for (let index = 0; index < 256; index += 1) {
    seed = (1103515245 * seed + 12345) >>> 0;
    const sensitive = `C:\\Users\\person-${index}\\state-${seed.toString(16)}.json::<html>token=${seed}</html>`;
    const line = collectorFailureLine(new Error(sensitive));
    assert.equal(line, '[operational-alert-collector] FAILED stage=collector category=operation_failed');
    assert.equal(line.includes(sensitive), false);
    assert.doesNotMatch(line, /Users|token|html|state-/i);
  }
});

test('atomic rename failure preserves the last committed collector cursor', async (t) => {
  const statePath = path.join(os.tmpdir(), `calibrate-alert-atomic-${process.pid}-${Date.now()}.json`);
  t.after(() => rm(statePath, { force: true }));
  t.after(() => rm(`${statePath}.${process.pid}.tmp`, { force: true }));
  const committed = {
    schema_version: 2,
    environment: 'staging',
    baseline: {
      sampled_at: '2026-08-09T11:50:00.000Z',
      snapshot: sanitizeMetricsSnapshot(metricsSnapshot()),
    },
  };
  await writeFile(statePath, `${JSON.stringify(committed)}\n`, 'utf8');
  const replacement = {
    ...committed,
    baseline: { ...committed.baseline, sampled_at: '2026-08-09T12:00:00.000Z' },
  };
  await assert.rejects(
    atomicWriteCollectorState(statePath, replacement, {
      writeFile,
      rename: async () => { throw new Error('injected rename failure with C:\\Users\\private'); },
      rm,
    }),
    /injected rename failure/,
  );
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), committed);
});

test('stale lock takeover is owner-safe and JSON body reads time out below the lease', async (t) => {
  const lockPath = path.join(os.tmpdir(), `calibrate-alert-lock-${process.pid}-${Date.now()}.lock`);
  t.after(() => rm(lockPath, { force: true }));
  const oldOwner = await acquireCollectorLock(lockPath, new Date('2026-08-09T10:00:00.000Z'));
  const newOwner = await acquireCollectorLock(lockPath, new Date('2026-08-09T10:21:00.000Z'));
  assert.notEqual(oldOwner, newOwner);
  await releaseCollectorLock(lockPath, oldOwner);
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).owner, newOwner);
  await releaseCollectorLock(lockPath, newOwner);
  await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' });

  const timeoutSink = createHttpAlertSink({
    sinkUrl: 'https://alerts.example.invalid/v1/alerts',
    sinkToken: 'sink-token-123456',
    environment: 'staging',
    requestTimeoutMs: 5,
    fetchImpl: async () => new Response(new ReadableStream({ start() {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    async () => timeoutSink.send({
      correlation_id: 'aaaaaaaaaaaaaaaa',
      code: 'provider_failure_warning',
      owner_role: 'backend_maintainer',
      dimensions: {},
    }),
    /timed out/,
  );
});

test('remote JSON responses reject declared and streamed bodies above the byte cap', async () => {
  const alert = {
    correlation_id: 'aaaaaaaaaaaaaaaa',
    code: 'provider_failure_warning',
    owner_role: 'backend_maintainer',
    dimensions: {},
  };
  const sinkOptions = {
    sinkUrl: 'https://alerts.example.invalid/v1/alerts',
    sinkToken: 'sink-token-123456',
    environment: 'staging',
  };
  const declaredOversizeSink = createHttpAlertSink({
    ...sinkOptions,
    fetchImpl: async () => new Response('{}', {
      status: 202,
      headers: { 'content-length': String(1024 * 1024 + 1) },
    }),
  });
  await assert.rejects(() => declaredOversizeSink.send(alert), /exceeded 1048576 bytes/);

  const chunk = new Uint8Array(600_000).fill(0x20);
  const streamedOversizeSink = createHttpAlertSink({
    ...sinkOptions,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 202 }),
  });
  await assert.rejects(() => streamedOversizeSink.send(alert), /exceeded 1048576 bytes/);
});
test('collector rejects metrics tokens shorter than the backend contract', async (t) => {
  const statePath = path.join(os.tmpdir(), `calibrate-alert-token-${process.pid}-${Date.now()}.json`);
  t.after(() => rm(statePath, { force: true }));
  t.after(() => rm(`${statePath}.lock`, { force: true }));
  const sink = { environment: 'staging', send: async () => 'aaaaaaaaaaaaaaaa' };
  const input = collectorInput(statePath, sink, async () => { throw new Error('must not fetch'); }, new Date());
  await assert.rejects(
    async () => collectOperationalAlertsOnce({ ...input, metricsToken: 'short-metrics-token' }),
    /at least 32 characters/,
  );
});

test('collector persists only fixed aggregate fields', () => {
  const sanitized = sanitizeMetricsSnapshot({
    ...metricsSnapshot(),
    email: 'person@example.invalid',
    operations: {
      food_provider_request: { attempts: 20, failures: 2, endpoint: 'https://private.invalid' },
      private_operation: { attempts: 999, failures: 999 },
    },
    client_diagnostics: {
      by_tuple: [{
        event: 'web_vital',
        operation: 'largest_contentful_paint',
        route: 'today',
        platform: 'web',
        version: '0.14.0',
        outcome: 'poor',
        duration_bucket: '4_s_or_more',
        count: 50,
        token: 'private',
      }],
    },
  });
  const encoded = JSON.stringify(sanitized);
  assert.equal(encoded.includes('example.invalid'), false);
  assert.equal(encoded.includes('private_operation'), false);
  assert.equal(encoded.includes('endpoint'), false);
  assert.equal(encoded.includes('token'), false);
  assert.equal(sanitized.operations.food_provider_request.attempts, 20);
  assert.equal(sanitized.client_diagnostics.by_tuple.length, 1);
});

test('collector persists a 10-minute same-process sample and dispatches the next delta once', async (t) => {
  const statePath = path.join(os.tmpdir(), `calibrate-alert-state-${process.pid}-${Date.now()}.json`);
  t.after(() => rm(statePath, { force: true }));
  t.after(() => rm(`${statePath}.lock`, { force: true }));
  const fetchImpl = fixtureFetch([
    metricsSnapshot(),
    metricsSnapshot({ food_provider_request: { attempts: 20, failures: 2 } }),
  ]);
  const delivered = [];
  const sink = {
    environment: 'staging',
    send: async (alert) => {
      delivered.push(alert);
      return 'aaaaaaaaaaaaaaaa';
    },
  };

  const initialized = await collectOperationalAlertsOnce(
    collectorInput(statePath, sink, fetchImpl, new Date('2026-08-09T11:50:00.000Z')),
  );
  assert.deepEqual(initialized, { alerts: [], receipts: [], initialized: true, rebaselined: false, retried: false });
  const result = await collectOperationalAlertsOnce(
    collectorInput(statePath, sink, fetchImpl, new Date('2026-08-09T12:00:00.000Z')),
  );
  assert.equal(result.initialized, false);
  assert.equal(result.rebaselined, false);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].code, 'provider_failure_warning');
  assert.deepEqual(result.receipts, ['aaaaaaaaaaaaaaaa']);
  assert.equal(delivered.length, 1);
  const state = await readFile(statePath, 'utf8');
  assert.match(state, /"sampled_at": "2026-08-09T12:00:00.000Z"/);
  assert.doesNotMatch(state, /token|email|url|path|payload/i);
});

test('collector dispatches a release mismatch from its first observation', async (t) => {
  const statePath = path.join(os.tmpdir(), `calibrate-alert-first-release-${process.pid}-${Date.now()}.json`);
  t.after(() => rm(statePath, { force: true }));
  t.after(() => rm(`${statePath}.lock`, { force: true }));
  const delivered = [];
  const sink = {
    environment: 'staging',
    send: async (alert) => {
      delivered.push(alert);
      return 'bbbbbbbbbbbbbbbb';
    },
  };

  const result = await collectOperationalAlertsOnce(collectorInput(
    statePath,
    sink,
    fixtureFetch([metricsSnapshot()], '0.13.3'),
    new Date('2026-08-09T11:50:00.000Z'),
  ));

  assert.equal(result.initialized, true);
  assert.equal(result.retried, false);
  assert.deepEqual(result.alerts.map((alert) => alert.code), ['release_version_mismatch']);
  assert.deepEqual(result.receipts, ['bbbbbbbbbbbbbbbb']);
  assert.equal(delivered.length, 1);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.pending, undefined);
  assert.equal(state.baseline.sampled_at, '2026-08-09T11:50:00.000Z');
});

test('collector rebaselines off-cadence, supplies release and scheduler inputs, and rejects concurrent runs', async (t) => {
  const statePath = path.join(os.tmpdir(), `calibrate-alert-cadence-${process.pid}-${Date.now()}.json`);
  t.after(() => rm(statePath, { force: true }));
  t.after(() => rm(`${statePath}.lock`, { force: true }));
  const snapshots = [
    metricsSnapshot({}, '2026-08-09T11:39:00.000Z'),
    metricsSnapshot({}, '2026-08-09T11:59:00.000Z'),
    metricsSnapshot({}, '2026-08-09T11:30:00.000Z'),
  ];
  const fetchImpl = fixtureFetch(snapshots, '0.13.3');
  const delivered = [];
  const sink = { environment: 'staging', send: async (alert) => { delivered.push(alert); return 'cccccccccccccccc'; } };
  const base = collectorInput(statePath, sink, fetchImpl, new Date('2026-08-09T11:40:00.000Z'));
  await collectOperationalAlertsOnce(base);
  const offCadence = await collectOperationalAlertsOnce({ ...base, now: new Date('2026-08-09T12:00:00.000Z') });
  assert.equal(offCadence.rebaselined, true);
  assert.deepEqual(delivered.map((alert) => alert.code), ['release_version_mismatch']);

  const evaluated = await collectOperationalAlertsOnce({
    ...base,
    reminderIntervalMs: 60_000,
    now: new Date('2026-08-09T12:10:00.000Z'),
  });
  assert.deepEqual(evaluated.alerts.map((alert) => alert.code).sort(), [
    'release_version_mismatch',
    'reminder_scheduler_stale',
  ]);
  assert.equal(new Set(evaluated.alerts.map((alert) => alert.correlation_id)).size, 1);

  await writeFile(`${statePath}.lock`, JSON.stringify({ acquired_at: '2026-08-09T12:10:00.000Z' }));
  await assert.rejects(
    collectOperationalAlertsOnce({ ...base, now: new Date('2026-08-09T12:11:00.000Z') }),
    /already running/,
  );
});

test('partial sink failure retries the exact persisted window and advances state once', async (t) => {
  const statePath = path.join(os.tmpdir(), `calibrate-alert-retry-${process.pid}-${Date.now()}.json`);
  t.after(() => rm(statePath, { force: true }));
  t.after(() => rm(`${statePath}.lock`, { force: true }));
  const fetchImpl = fixtureFetch([
    metricsSnapshot(),
    metricsSnapshot({
      food_provider_request: { attempts: 20, failures: 2 },
      weight_trend_recompute: { attempts: 20, failures: 1 },
    }),
  ]);
  let failedSecondAlert = false;
  const sinkRequests = [];
  const sink = createHttpAlertSink({
    sinkUrl: 'https://alerts.example.invalid/v1/alerts',
    sinkToken: 'sink-token-123456',
    environment: 'staging',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const key = new Headers(init.headers).get('idempotency-key');
      sinkRequests.push({ code: body.alert.code, key });
      if (body.alert.code === 'trend_failure_warning' && !failedSecondAlert) {
        failedSecondAlert = true;
        return new Response(JSON.stringify({ accepted: false, environment: 'staging' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      const receiptId = body.alert.code === 'provider_failure_warning'
        ? 'dddddddddddddddd'
        : 'eeeeeeeeeeeeeeee';
      return new Response(JSON.stringify({
        accepted: true,
        environment: 'staging',
        receipt_id: receiptId,
      }), { status: 202, headers: { 'content-type': 'application/json' } });
    },
  });
  const base = collectorInput(statePath, sink, fetchImpl, new Date('2026-08-09T11:50:00.000Z'));
  await collectOperationalAlertsOnce(base);
  await assert.rejects(
    async () => collectOperationalAlertsOnce({ ...base, now: new Date('2026-08-09T12:00:00.000Z') }),
    /target environment/,
  );
  const pendingState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(pendingState.environment, 'staging');
  assert.equal(pendingState.pending.environment, 'staging');
  assert.equal(pendingState.pending.sampled_at, '2026-08-09T12:00:00.000Z');
  assert.match(pendingState.pending.correlation_id, /^[a-f0-9]{64}$/);

  const productionSink = { environment: 'production', send: async () => { throw new Error('must not send'); } };
  await assert.rejects(
    async () => collectOperationalAlertsOnce({
      ...base,
      sink: productionSink,
      now: new Date('2026-08-09T12:00:30.000Z'),
    }),
    /state environment does not match/,
  );

  const retried = await collectOperationalAlertsOnce({ ...base, now: new Date('2026-08-09T12:01:00.000Z') });
  assert.equal(retried.retried, true);
  assert.deepEqual(retried.alerts.map((alert) => alert.code), [
    'provider_failure_warning',
    'trend_failure_warning',
  ]);
  const providerAttempts = sinkRequests.filter((request) => request.code === 'provider_failure_warning');
  assert.equal(providerAttempts.length, 2);
  assert.equal(providerAttempts[0].key, providerAttempts[1].key);
  const trendAttempts = sinkRequests.filter((request) => request.code === 'trend_failure_warning');
  assert.equal(trendAttempts.length, 2);
  assert.equal(trendAttempts[0].key, trendAttempts[1].key);
  const advancedState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(advancedState.pending, undefined);
  assert.equal(advancedState.baseline.sampled_at, '2026-08-09T12:00:00.000Z');
});

test('synthetic staging smoke uses idempotent HTTPS transport and requires a staging receipt', async () => {
  const requests = [];
  const sink = createHttpAlertSink({
    sinkUrl: 'https://alerts.example.invalid/v1/alerts',
    sinkToken: 'sink-token-123456',
    environment: 'staging',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        accepted: true,
        environment: 'staging',
        receipt_id: 'bbbbbbbbbbbbbbbb',
      }), { status: 202, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await runSyntheticStagingSmoke({ sink });
  assert.equal(result.alerts[0].code, 'provider_failure_warning');
  assert.deepEqual(result.receipts, ['bbbbbbbbbbbbbbbb']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://alerts.example.invalid/v1/alerts');
  assert.equal(requests[0].init.method, 'POST');
  const headers = new Headers(requests[0].init.headers);
  assert.equal(headers.get('authorization'), 'Bearer sink-token-123456');
  assert.match(headers.get('idempotency-key'), /^[a-f0-9]{64}$/);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.environment, 'staging');
  assert.equal(body.idempotency_key, headers.get('idempotency-key'));
  assert.equal(body.alert.owner_role, 'backend_maintainer');
  assert.doesNotMatch(JSON.stringify(body), /email|food_name|weight|calorie|barcode|payload/i);

  const wrongEnvironmentSink = createHttpAlertSink({
    sinkUrl: 'https://alerts.example.invalid/v1/alerts',
    sinkToken: 'sink-token-123456',
    environment: 'production',
    fetchImpl: async () => { throw new Error('must not send'); },
  });
  await assert.rejects(runSyntheticStagingSmoke({ sink: wrongEnvironmentSink }), /requires.*staging/i);

  const rejectingSink = createHttpAlertSink({
    sinkUrl: 'https://alerts.example.invalid/v1/alerts',
    sinkToken: 'sink-token-123456',
    environment: 'staging',
    fetchImpl: async () => new Response(JSON.stringify({
      accepted: true,
      environment: 'production',
      receipt_id: 'person@example.invalid',
    }), { status: 202, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(runSyntheticStagingSmoke({ sink: rejectingSink }), /target environment/);
});