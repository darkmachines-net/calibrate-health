/** @file Deterministic operational alert evaluation from privacy-safe bounded aggregate evidence. */

import crypto from 'node:crypto';

const ALERT_OWNER = Object.freeze({
  auth_refresh_failure_warning: 'backend_maintainer',
  auth_request_failure_warning: 'backend_maintainer',
  http_5xx_page: 'service_operator',
  http_5xx_warning: 'service_operator',
  notification_failure_page: 'backend_maintainer',
  onboarding_failure_warning: 'client_maintainer',
  provider_failure_warning: 'backend_maintainer',
  release_version_mismatch: 'release_engineer',
  reminder_scheduler_stale: 'service_operator',
  sync_failure_warning: 'backend_maintainer',
  trend_failure_warning: 'backend_maintainer',
  web_vital_poor_warning: 'client_maintainer',
});
const OPAQUE_ID_PATTERN = /^(?:[a-f0-9]{16,64}|[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i;
const DIMENSION_VALUES = Object.freeze({
  operation: new Set([
    'onboarding_complete',
    'food_provider_request',
    'notification_delivery',
    'weight_trend_recompute',
    'largest_contentful_paint',
    'interaction_to_next_paint',
    'cumulative_layout_shift',
  ]),
  route: new Set(['app_shell', 'onboarding', 'today', 'saved_foods', 'notifications', 'progress']),
  platform: new Set(['web', 'android_phone', 'ios', 'wear_os']),
  signal: new Set(['auth_requests', 'auth_mobile_refresh']),
});

function counter(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function delta(previous, current) {
  return Math.max(0, counter(current) - counter(previous));
}

function operationDelta(previous, current, name) {
  const before = previous.operations?.[name] ?? {};
  const after = current.operations?.[name] ?? {};
  return { attempts: delta(before.attempts, after.attempts), failures: delta(before.failures, after.failures) };
}

function tupleKey(tuple) {
  return [tuple.event, tuple.operation, tuple.route, tuple.platform, tuple.version, tuple.outcome, tuple.duration_bucket].join('\u001f');
}

function clientTupleDeltas(previous, current) {
  const before = new Map((previous.client_diagnostics?.by_tuple ?? []).map((tuple) => [tupleKey(tuple), counter(tuple.count)]));
  return (current.client_diagnostics?.by_tuple ?? []).map((tuple) => ({
    ...tuple,
    count: delta(before.get(tupleKey(tuple)), tuple.count),
  })).filter((tuple) => tuple.count > 0);
}

function safeDimensions(dimensions) {
  const safe = {};
  for (const [key, value] of Object.entries(dimensions)) {
    if (typeof value !== 'string') continue;
    if (Object.hasOwn(DIMENSION_VALUES, key) && DIMENSION_VALUES[key].has(value)) safe[key] = value;
    if (['version', 'expected_version', 'observed_version'].includes(key) && VERSION_PATTERN.test(value)) safe[key] = value;
  }
  return safe;
}

/** Accepts only the bounded opaque identifier format used in operational evidence. */
export function isOpaqueOperationalId(value) {
  return typeof value === 'string' && OPAQUE_ID_PATTERN.test(value);
}

function opaqueCorrelationId(value) {
  return isOpaqueOperationalId(value) ? value : crypto.randomUUID();
}

function addAlert(alerts, code, severity, correlationId, numerator, denominator, dimensions = {}) {
  alerts.push({
    code,
    severity,
    owner_role: ALERT_OWNER[code],
    correlation_id: correlationId,
    window_minutes: 10,
    numerator,
    ...(denominator === undefined ? {} : { denominator }),
    dimensions: safeDimensions(dimensions),
  });
}

function addOperationRateAlert(alerts, previous, current, operation, code, threshold, minimum, severity, correlationId) {
  const measured = operationDelta(previous, current, operation);
  if (measured.attempts >= minimum && measured.failures / measured.attempts >= threshold) {
    addAlert(alerts, code, severity, correlationId, measured.failures, measured.attempts, { operation });
  }
}

/** Evaluate fixed, privacy-safe aggregate deltas. Callers own polling and alert transport. */
export function evaluateOperationalAlerts({
  previous,
  current,
  now = new Date(),
  reminderIntervalMs = 15 * 60 * 1000,
  correlationId = crypto.randomUUID(),
  release = null,
}) {
  const alerts = [];
  correlationId = opaqueCorrelationId(correlationId);
  const sameProcess = previous.process_started_at === current.process_started_at;
  if (sameProcess) {
    const requestTotal = delta(previous.requests?.total, current.requests?.total);
    const serverFailures = delta(previous.requests?.serverFailures, current.requests?.serverFailures);
    const serverFailureRate = serverFailures / Math.max(1, requestTotal);
    if (requestTotal >= 100 && serverFailures >= 10 && serverFailureRate >= 0.05) {
      addAlert(alerts, 'http_5xx_page', 'page', correlationId, serverFailures, requestTotal);
    } else if (requestTotal >= 100 && serverFailures >= 5 && serverFailureRate >= 0.02) {
      addAlert(alerts, 'http_5xx_warning', 'warning', correlationId, serverFailures, requestTotal);
    }

    const authBefore = previous.requests?.by_category?.auth ?? {};
    const authAfter = current.requests?.by_category?.auth ?? {};
    const authTotal = delta(authBefore.total, authAfter.total);
    const authFailures = delta(authBefore.serverFailures, authAfter.serverFailures);
    const refresh = operationDelta(previous, current, 'auth_mobile_refresh');
    if (authTotal >= 50 && authFailures / authTotal >= 0.02) {
      addAlert(alerts, 'auth_request_failure_warning', 'warning', correlationId, authFailures, authTotal, {
        signal: 'auth_requests',
      });
    }
    if (refresh.attempts >= 20 && refresh.failures / refresh.attempts >= 0.05) {
      addAlert(alerts, 'auth_refresh_failure_warning', 'warning', correlationId, refresh.failures, refresh.attempts, {
        signal: 'auth_mobile_refresh',
      });
    }

    addOperationRateAlert(alerts, previous, current, 'food_provider_request', 'provider_failure_warning', 0.1, 20, 'warning', correlationId);
    addOperationRateAlert(alerts, previous, current, 'notification_delivery', 'notification_failure_page', 0.1, 20, 'page', correlationId);
    addOperationRateAlert(alerts, previous, current, 'weight_trend_recompute', 'trend_failure_warning', 0.05, 20, 'warning', correlationId);

    const syncNames = ['health_connect_ingestion', 'watch_mutation_reconciliation'];
    const sync = syncNames.reduce((total, name) => {
      const measured = operationDelta(previous, current, name);
      return { attempts: total.attempts + measured.attempts, failures: total.failures + measured.failures };
    }, { attempts: 0, failures: 0 });
    if (sync.attempts >= 20 && sync.failures / sync.attempts >= 0.05) {
      addAlert(alerts, 'sync_failure_warning', 'warning', correlationId, sync.failures, sync.attempts);
    }

    const tuples = clientTupleDeltas(previous, current);
    const onboardingGroups = new Map();
    for (const tuple of tuples.filter((item) => item.operation === 'onboarding_complete' && item.outcome === 'failure')) {
      const key = [tuple.platform, tuple.version].join('\u001f');
      const group = onboardingGroups.get(key) ?? { count: 0, platform: tuple.platform, version: tuple.version };
      group.count += tuple.count;
      onboardingGroups.set(key, group);
    }
    for (const group of onboardingGroups.values()) {
      if (group.count >= 5) {
        addAlert(alerts, 'onboarding_failure_warning', 'warning', correlationId, group.count, undefined, {
          operation: 'onboarding_complete',
          platform: group.platform,
          version: group.version,
        });
      }
    }

    const vitalGroups = new Map();
    for (const tuple of tuples.filter((item) => item.event === 'web_vital')) {
      const key = [tuple.operation, tuple.route, tuple.version].join('\u001f');
      const group = vitalGroups.get(key) ?? { total: 0, poor: 0, operation: tuple.operation, route: tuple.route, version: tuple.version };
      group.total += tuple.count;
      group.poor += tuple.outcome === 'poor' ? tuple.count : 0;
      vitalGroups.set(key, group);
    }
    for (const group of vitalGroups.values()) {
      if (group.total >= 50 && group.poor / group.total >= 0.1) {
        addAlert(alerts, 'web_vital_poor_warning', 'warning', correlationId, group.poor, group.total, group);
      }
    }
  }

  const lastSuccessAt = current.background_jobs?.reminder_scheduler?.lastSuccessAt;
  const successAtMs = typeof lastSuccessAt === 'string' ? Date.parse(lastSuccessAt) : Number.NaN;
  const processStartedAtMs = typeof current.process_started_at === 'string' ? Date.parse(current.process_started_at) : Number.NaN;
  const stalenessLimitMs = reminderIntervalMs * 2 + 5 * 60 * 1000;
  const missingSuccessIsStale = !Number.isFinite(successAtMs)
    && (!Number.isFinite(processStartedAtMs) || now.getTime() - processStartedAtMs > stalenessLimitMs);
  if (missingSuccessIsStale || (Number.isFinite(successAtMs) && now.getTime() - successAtMs > stalenessLimitMs)) {
    addAlert(alerts, 'reminder_scheduler_stale', 'page', correlationId, 1, 1);
  }

  if (release && (release.compatible === false || release.observed_server_version !== release.expected_server_version)) {
    addAlert(alerts, 'release_version_mismatch', 'page', correlationId, 1, 1, {
      expected_version: release.expected_server_version,
      observed_version: release.observed_server_version,
    });
  }
  return alerts;
}

/** Evaluates current operational alerts and sends each result through the supplied sink. */
export async function dispatchOperationalAlerts(input, sink) {
  const alerts = evaluateOperationalAlerts(input);
  for (const alert of alerts) await sink.send(alert);
  return alerts;
}
