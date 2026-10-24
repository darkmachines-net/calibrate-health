/** @file Bounded operational signal collection, durable aggregate state, and synthetic staging smoke checks. */

import crypto from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  dispatchOperationalAlerts,
  isOpaqueOperationalId,
} from './operational-alerts.mjs';

const FIXED_OPERATIONS = [
  'auth_mobile_refresh',
  'food_provider_request',
  'health_connect_ingestion',
  'notification_delivery',
  'watch_mutation_reconciliation',
  'weight_trend_recompute',
];
const TUPLE_VALUES = Object.freeze({
  event: new Set(['operation_failure', 'web_vital']),
  operation: new Set([
    'onboarding_complete',
    'largest_contentful_paint',
    'interaction_to_next_paint',
    'cumulative_layout_shift',
  ]),
  route: new Set(['app_shell', 'onboarding', 'today', 'saved_foods', 'notifications', 'progress']),
  platform: new Set(['web', 'android_phone', 'ios', 'wear_os']),
  outcome: new Set(['failure', 'good', 'needs_improvement', 'poor']),
  duration_bucket: new Set([
    'not_applicable',
    'under_100_ms',
    '100_to_200_ms',
    '200_to_500_ms',
    '500_ms_to_1_s',
    '1_to_2_5_s',
    '2_5_to_4_s',
    '4_s_or_more',
  ]),
});
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SAMPLE_INTERVAL_MS = 10 * 60 * 1000;
const SAMPLE_TOLERANCE_MS = 2 * 60 * 1000;
const LOCK_STALE_MS = 20 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_BODY_LIMIT_BYTES = 1024 * 1024; // Bounds every remote JSON body before parsing it in memory.
const ALERT_ENVIRONMENTS = new Set(['staging', 'production']);

function counter(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function safeOperationCounters(value) {
  return { attempts: counter(value?.attempts), failures: counter(value?.failures) };
}

function safeTuple(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const [key, allowed] of Object.entries(TUPLE_VALUES)) {
    if (typeof value[key] !== 'string' || !allowed.has(value[key])) return null;
  }
  if (typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version)) return null;
  return {
    event: value.event,
    operation: value.operation,
    route: value.route,
    platform: value.platform,
    version: value.version,
    outcome: value.outcome,
    duration_bucket: value.duration_bucket,
    count: counter(value.count),
  };
}

/** Persist only the fixed aggregate fields consumed by the alert evaluator. */
export function sanitizeMetricsSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Diagnostics metrics response must be an object.');
  }
  const processStartedAt = isoTimestamp(value.process_started_at);
  if (!processStartedAt) throw new Error('Diagnostics metrics response has no valid process_started_at.');
  return {
    process_started_at: processStartedAt,
    requests: {
      total: counter(value.requests?.total),
      serverFailures: counter(value.requests?.serverFailures),
      by_category: {
        auth: {
          total: counter(value.requests?.by_category?.auth?.total),
          serverFailures: counter(value.requests?.by_category?.auth?.serverFailures),
        },
      },
    },
    operations: Object.fromEntries(FIXED_OPERATIONS.map((name) => [
      name,
      safeOperationCounters(value.operations?.[name]),
    ])),
    client_diagnostics: {
      by_tuple: Array.isArray(value.client_diagnostics?.by_tuple)
        ? value.client_diagnostics.by_tuple.map(safeTuple).filter(Boolean)
        : [],
    },
    background_jobs: {
      reminder_scheduler: {
        lastSuccessAt: isoTimestamp(value.background_jobs?.reminder_scheduler?.lastSuccessAt),
      },
    },
  };
}

function configuredHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error(`${label} must be an absolute HTTPS URL without credentials, query, or fragment.`);
  }
  return parsed.toString();
}

function requiredSecret(value, label) {
  if (typeof value !== 'string' || value.trim().length < 16) {
    throw new Error(`${label} must be configured with a secret of at least 16 characters.`);
  }
  return value.trim();
}

function requiredMetricsToken(value) {
  if (typeof value !== 'string' || value.trim().length < 32) {
    throw new Error('CALIBRATE_DIAGNOSTICS_METRICS_TOKEN must be at least 32 characters.');
  }
  return value.trim();
}

function configuredEnvironment(value) {
  if (typeof value !== 'string' || !ALERT_ENVIRONMENTS.has(value)) {
    throw new Error('CALIBRATE_ALERT_ENVIRONMENT must be staging or production.');
  }
  return value;
}

function configuredVersion(value, label) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new Error(`${label} must be a stable semantic version.`);
  }
  return value;
}

function configuredInterval(value) {
  const interval = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(interval) || interval < 60_000 || interval > 86_400_000) {
    throw new Error('CALIBRATE_REMINDER_INTERVAL_MS must be an integer from 60000 through 86400000.');
  }
  return interval;
}

function stableId(parts) {
  return crypto.createHash('sha256').update(parts.join('\u001f')).digest('hex');
}

function configuredRequestTimeout(value = REQUEST_TIMEOUT_MS) {
  if (!Number.isSafeInteger(value) || value < 1 || value > REQUEST_TIMEOUT_MS) {
    throw new Error(`Collector request timeout must be an integer from 1 through ${REQUEST_TIMEOUT_MS}.`);
  }
  return value;
}

/** Read a remote JSON body without buffering more than the reviewed response limit. */
async function readBoundedJson(response, label) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_BODY_LIMIT_BYTES) {
    throw new Error(`${label} response exceeded ${RESPONSE_BODY_LIMIT_BYTES} bytes.`);
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error(`${label} returned an invalid response body.`);
      totalBytes += value.byteLength;
      if (totalBytes > RESPONSE_BODY_LIMIT_BYTES) {
        try { await reader.cancel(); } catch { /* The size violation remains the authoritative error. */ }
        throw new Error(`${label} response exceeded ${RESPONSE_BODY_LIMIT_BYTES} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}
async function boundedJsonRequest({ url, init, fetchImpl, label, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const controller = new AbortController();
  const boundedTimeoutMs = configuredRequestTimeout(timeoutMs);
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out.`));
    }, boundedTimeoutMs);
  });
  try {
    const request = (async () => {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      return { response, body: await readBoundedJson(response, label) };
    })();
    return await Promise.race([request, timeout]);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Creates an authenticated HTTPS alert sink with environment-scoped idempotency keys and request deadlines. */
export function createHttpAlertSink({
  sinkUrl,
  sinkToken,
  environment,
  fetchImpl = fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const url = configuredHttpsUrl(sinkUrl, 'CALIBRATE_ALERT_SINK_URL');
  const token = requiredSecret(sinkToken, 'CALIBRATE_ALERT_SINK_TOKEN');
  const targetEnvironment = configuredEnvironment(environment);
  return {
    environment: targetEnvironment,
    async send(alert) {
      const idempotencyKey = stableId([
        alert.correlation_id,
        alert.code,
        alert.owner_role,
        JSON.stringify(alert.dimensions),
      ]);
      const { response, body: acknowledgement } = await boundedJsonRequest({
        url,
        fetchImpl,
        label: 'Alert sink request',
        timeoutMs: requestTimeoutMs,
        init: {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({ environment: targetEnvironment, idempotency_key: idempotencyKey, alert }),
        },
      });
      if (!response.ok
        || acknowledgement?.accepted !== true
        || acknowledgement?.environment !== targetEnvironment
        || !isOpaqueOperationalId(acknowledgement.receipt_id)) {
        throw new Error('Configured alert sink did not return an accepted opaque receipt for the target environment.');
      }
      return acknowledgement.receipt_id;
    },
  };
}

function baselineState(snapshot, sampledAt) {
  return { sampled_at: sampledAt.toISOString(), snapshot };
}

function collectorState(environment, baseline, pending = null) {
  return {
    schema_version: 2,
    environment,
    baseline,
    ...(pending ? { pending } : {}),
  };
}

function sanitizeBaseline(value) {
  const sampledAt = isoTimestamp(value?.sampled_at);
  if (!sampledAt) throw new Error('Collector state baseline is invalid.');
  return { sampled_at: sampledAt, snapshot: sanitizeMetricsSnapshot(value.snapshot) };
}

function sanitizePending(value) {
  const sampledAt = isoTimestamp(value?.sampled_at);
  if (!sampledAt || !isOpaqueOperationalId(value?.correlation_id)) {
    throw new Error('Collector pending window is invalid.');
  }
  const expectedServerVersion = configuredVersion(
    value?.release?.expected_server_version,
    'Pending expected server version',
  );
  const observedServerVersion = configuredVersion(
    value?.release?.observed_server_version,
    'Pending observed server version',
  );
  return {
    sampled_at: sampledAt,
    environment: configuredEnvironment(value.environment),
    correlation_id: value.correlation_id,
    reminder_interval_ms: configuredInterval(value.reminder_interval_ms),
    release: {
      compatible: observedServerVersion === expectedServerVersion,
      expected_server_version: expectedServerVersion,
      observed_server_version: observedServerVersion,
    },
    previous_snapshot: sanitizeMetricsSnapshot(value.previous_snapshot),
    current_snapshot: sanitizeMetricsSnapshot(value.current_snapshot),
  };
}

async function readCollectorState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    if (parsed?.schema_version !== 2) throw new Error('Collector state schema is invalid.');
    return {
      environment: configuredEnvironment(parsed.environment),
      baseline: sanitizeBaseline(parsed.baseline),
      pending: parsed.pending ? sanitizePending(parsed.pending) : null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Atomically replaces collector state and removes the temporary file even after failure. */
export async function atomicWriteCollectorState(
  statePath,
  value,
  io = { writeFile, rename, rm },
) {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  try {
    await io.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await io.rename(temporaryPath, statePath);
  } finally {
    await io.rm(temporaryPath, { force: true });
  }
}

/** Acquires an exclusive collector lock with an opaque owner, applying the stale-lock recovery policy. */
export async function acquireCollectorLock(lockPath, now) {
  const owner = crypto.randomBytes(16).toString('hex');
  const payload = `${JSON.stringify({ acquired_at: now.toISOString(), owner })}\n`;
  try {
    await writeFile(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
    return owner;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  let acquiredAt = Number.NaN;
  try {
    acquiredAt = Date.parse(JSON.parse(await readFile(lockPath, 'utf8')).acquired_at);
  } catch {
    // Invalid locks are treated as stale and replaced below.
  }
  if (Number.isFinite(acquiredAt) && now.getTime() - acquiredAt <= LOCK_STALE_MS) {
    throw new Error('Operational alert collector is already running for this state file.');
  }
  await rm(lockPath, { force: true });
  await writeFile(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
  return owner;
}

/** Removes the collector lock only when the persisted owner still matches the caller. */
export async function releaseCollectorLock(lockPath, owner) {
  try {
    const persisted = JSON.parse(await readFile(lockPath, 'utf8'));
    if (persisted?.owner === owner) await rm(lockPath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function fetchCollectorInputs({
  metricsUrl,
  metricsToken,
  clientConfigUrl,
  fetchImpl = fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const { response: metricsResponse, body: metricsBody } = await boundedJsonRequest({
    url: configuredHttpsUrl(metricsUrl, 'CALIBRATE_DIAGNOSTICS_METRICS_URL'),
    fetchImpl,
    label: 'Private diagnostics request',
    timeoutMs: requestTimeoutMs,
    init: {
      method: 'GET',
      headers: { authorization: `Bearer ${requiredMetricsToken(metricsToken)}` },
      cache: 'no-store',
    },
  });
  if (!metricsResponse.ok) throw new Error(`Private diagnostics collector returned status ${metricsResponse.status}.`);
  const { response: configResponse, body: config } = await boundedJsonRequest({
    url: configuredHttpsUrl(clientConfigUrl, 'CALIBRATE_CLIENT_CONFIG_URL'),
    fetchImpl,
    label: 'Client config request',
    timeoutMs: requestTimeoutMs,
    init: { method: 'GET', cache: 'no-store' },
  });
  if (!configResponse.ok) throw new Error(`Client config collector returned status ${configResponse.status}.`);
  return {
    snapshot: sanitizeMetricsSnapshot(metricsBody),
    observedServerVersion: configuredVersion(config?.server_version, 'Observed server version'),
  };
}
async function dispatchPendingWindow({ pending, baseline, statePath, sink, initialized = false }) {
  if (configuredEnvironment(sink?.environment) !== pending.environment) {
    throw new Error('Pending alert window environment does not match the configured sink.');
  }
  const receipts = [];
  const alerts = await dispatchOperationalAlerts({
    previous: pending.previous_snapshot,
    current: pending.current_snapshot,
    now: new Date(pending.sampled_at),
    reminderIntervalMs: pending.reminder_interval_ms,
    correlationId: pending.correlation_id,
    release: pending.release,
  }, {
    send: async (alert) => receipts.push(await sink.send(alert)),
  });
  const advancedBaseline = {
    sampled_at: pending.sampled_at,
    snapshot: pending.current_snapshot,
  };
  await atomicWriteCollectorState(statePath, collectorState(pending.environment, advancedBaseline));
  return { alerts, receipts, initialized, rebaselined: false, retried: baseline !== null };
}

/** Collects one operational snapshot under an exclusive lock, evaluates alerts, and persists delivery state. */
export async function collectOperationalAlertsOnce(input) {
  const now = input.now ?? new Date();
  const statePath = path.resolve(input.statePath);
  const lockPath = `${statePath}.lock`;
  const lockOwner = await acquireCollectorLock(lockPath, now);
  try {
    const sinkEnvironment = configuredEnvironment(input.sink?.environment);
    const state = await readCollectorState(statePath);
    if (state && state.environment !== sinkEnvironment) {
      throw new Error('Collector state environment does not match the configured sink.');
    }
    if (state?.pending) {
      return await dispatchPendingWindow({
        pending: state.pending,
        baseline: state.baseline,
        statePath,
        sink: input.sink,
      });
    }

    const expectedServerVersion = configuredVersion(input.expectedServerVersion, 'CALIBRATE_EXPECTED_SERVER_VERSION');
    const reminderIntervalMs = configuredInterval(input.reminderIntervalMs);
    const { snapshot: current, observedServerVersion } = await fetchCollectorInputs(input);
    if (!state && observedServerVersion === expectedServerVersion) {
      await atomicWriteCollectorState(statePath, collectorState(sinkEnvironment, baselineState(current, now)));
      return { alerts: [], receipts: [], initialized: true, rebaselined: false, retried: false };
    }

    if (!state) {
      const initialBaseline = baselineState(current, now);
      const pending = {
        sampled_at: now.toISOString(),
        environment: sinkEnvironment,
        correlation_id: stableId([current.process_started_at, now.toISOString(), expectedServerVersion]),
        reminder_interval_ms: reminderIntervalMs,
        release: {
          compatible: false,
          expected_server_version: expectedServerVersion,
          observed_server_version: observedServerVersion,
        },
        previous_snapshot: current,
        current_snapshot: current,
      };
      await atomicWriteCollectorState(statePath, collectorState(sinkEnvironment, initialBaseline, pending));
      return await dispatchPendingWindow({
        pending,
        baseline: null,
        statePath,
        sink: input.sink,
        initialized: true,
      });
    }

    const sampleGapMs = now.getTime() - Date.parse(state.baseline.sampled_at);
    const cadenceValid = sampleGapMs >= SAMPLE_INTERVAL_MS - SAMPLE_TOLERANCE_MS
      && sampleGapMs <= SAMPLE_INTERVAL_MS + SAMPLE_TOLERANCE_MS;
    if (!cadenceValid || state.baseline.snapshot.process_started_at !== current.process_started_at) {
      await atomicWriteCollectorState(statePath, collectorState(sinkEnvironment, baselineState(current, now)));
      return { alerts: [], receipts: [], initialized: false, rebaselined: true, retried: false };
    }

    const pending = {
      sampled_at: now.toISOString(),
      environment: sinkEnvironment,
      correlation_id: stableId([current.process_started_at, state.baseline.sampled_at, now.toISOString()]),
      reminder_interval_ms: reminderIntervalMs,
      release: {
        compatible: observedServerVersion === expectedServerVersion,
        expected_server_version: expectedServerVersion,
        observed_server_version: observedServerVersion,
      },
      previous_snapshot: state.baseline.snapshot,
      current_snapshot: current,
    };
    await atomicWriteCollectorState(statePath, collectorState(sinkEnvironment, state.baseline, pending));
    return await dispatchPendingWindow({ pending, baseline: null, statePath, sink: input.sink });
  } finally {
    await releaseCollectorLock(lockPath, lockOwner);
  }
}
/** Exercises alert delivery with synthetic data only when the sink explicitly targets staging. */
export async function runSyntheticStagingSmoke({ sink }) {
  if (sink?.environment !== 'staging') {
    throw new Error('Synthetic staging smoke requires CALIBRATE_ALERT_ENVIRONMENT=staging.');
  }
  const processStartedAt = '2026-08-09T10:00:00.000Z';
  const common = {
    process_started_at: processStartedAt,
    requests: { total: 0, serverFailures: 0, by_category: { auth: { total: 0, serverFailures: 0 } } },
    client_diagnostics: { by_tuple: [] },
    background_jobs: { reminder_scheduler: { lastSuccessAt: '2026-08-09T11:55:00.000Z' } },
  };
  const previous = sanitizeMetricsSnapshot({ ...common, operations: {} });
  const current = sanitizeMetricsSnapshot({
    ...common,
    operations: { food_provider_request: { attempts: 20, failures: 2 } },
  });
  const receipts = [];
  const alerts = await dispatchOperationalAlerts({
    previous,
    current,
    now: new Date('2026-08-09T12:00:00.000Z'),
    correlationId: '22222222-2222-4222-8222-222222222222',
  }, {
    send: async (alert) => receipts.push(await sink.send(alert)),
  });
  if (alerts.length !== 1 || alerts[0].code !== 'provider_failure_warning' || receipts.length !== 1) {
    throw new Error('Synthetic staging alert did not produce exactly one acknowledged provider warning.');
  }
  return { alerts, receipts };
}

/** Returns a fixed privacy-safe collector failure line without embedding exception details. */
export function collectorFailureLine() {
  return '[operational-alert-collector] FAILED stage=collector category=operation_failed';
}

async function main() {
  const environment = process.env.CALIBRATE_ALERT_ENVIRONMENT;
  const sink = createHttpAlertSink({
    sinkUrl: process.env.CALIBRATE_ALERT_SINK_URL,
    sinkToken: process.env.CALIBRATE_ALERT_SINK_TOKEN,
    environment,
  });
  if (process.argv.includes('--synthetic-staging-smoke')) {
    const result = await runSyntheticStagingSmoke({ sink });
    console.log(`[staging-alert-smoke] PASS environment=staging receipt_id=${result.receipts[0]}`);
    return;
  }
  const statePath = process.env.CALIBRATE_ALERT_STATE_PATH;
  if (typeof statePath !== 'string' || statePath.trim() === '') {
    throw new Error('CALIBRATE_ALERT_STATE_PATH must point to a persistent collector state file.');
  }
  const result = await collectOperationalAlertsOnce({
    metricsUrl: process.env.CALIBRATE_DIAGNOSTICS_METRICS_URL,
    metricsToken: process.env.CALIBRATE_DIAGNOSTICS_METRICS_TOKEN,
    clientConfigUrl: process.env.CALIBRATE_CLIENT_CONFIG_URL,
    expectedServerVersion: process.env.CALIBRATE_EXPECTED_SERVER_VERSION,
    reminderIntervalMs: process.env.CALIBRATE_REMINDER_INTERVAL_MS,
    statePath,
    sink,
  });
  console.log(`[operational-alert-collector] PASS alerts=${result.alerts.length} receipts=${result.receipts.length} initialized=${result.initialized} rebaselined=${result.rebaselined}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(collectorFailureLine());
    process.exitCode = 1;
  });
}