/** @file Regression coverage for operational alerts: uses volume-qualified threshold precedence and fixed owner roles. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateOperationalAlerts } from './operational-alerts.mjs';

const STARTED = '2026-08-09T10:00:00.000Z';
const NOW = new Date('2026-08-09T12:00:00.000Z');

function snapshot() {
  return {
    process_started_at: STARTED,
    requests: { total: 0, serverFailures: 0, by_category: {} },
    operations: {},
    client_diagnostics: { by_tuple: [] },
    background_jobs: { reminder_scheduler: { lastFinishedAt: '2026-08-09T11:55:00.000Z', lastSuccessAt: '2026-08-09T11:55:00.000Z' } },
  };
}

function evaluate(previous, current) {
  return evaluateOperationalAlerts({ previous, current, now: NOW, correlationId: '11111111-1111-4111-8111-111111111111' });
}

test('uses volume-qualified threshold precedence and fixed owner roles', () => {
  const previous = snapshot();
  const current = snapshot();
  current.requests = { total: 100, serverFailures: 10, by_category: {} };
  const alerts = evaluate(previous, current);
  assert.deepEqual(alerts.map((alert) => alert.code), ['http_5xx_page']);
  assert.equal(alerts[0].owner_role, 'service_operator');
  assert.equal(alerts[0].denominator, 100);
});

test('evaluates bounded joint client tuples without accepting raw context', () => {
  const previous = snapshot();
  const current = snapshot();
  current.client_diagnostics.by_tuple = [
    { event: 'web_vital', operation: 'largest_contentful_paint', route: 'today', platform: 'web', version: '0.14.0', outcome: 'good', duration_bucket: '1_to_2_5_s', count: 45 },
    { event: 'web_vital', operation: 'largest_contentful_paint', route: 'today', platform: 'web', version: '0.14.0', outcome: 'poor', duration_bucket: '4_s_or_more', count: 5 },
  ];
  const alerts = evaluate(previous, current);
  assert.deepEqual(alerts.map((alert) => alert.code), ['web_vital_poor_warning']);
  assert.deepEqual(alerts[0].dimensions, { operation: 'largest_contentful_paint', route: 'today', version: '0.14.0' });
  assert.doesNotMatch(JSON.stringify(alerts), /email|token|url|path|food|weight|calorie/i);
});

test('does not derive rate alerts across a process counter reset', () => {
  const previous = snapshot();
  const current = snapshot();
  current.process_started_at = '2026-08-09T11:59:00.000Z';
  current.requests = { total: 100, serverFailures: 100, by_category: {} };
  assert.deepEqual(evaluate(previous, current), []);
});

test('detects stale scheduler and incompatible release independently of counter deltas', () => {
  const previous = snapshot();
  const current = snapshot();
  current.background_jobs.reminder_scheduler.lastSuccessAt = '2026-08-09T11:00:00.000Z';
  current.background_jobs.reminder_scheduler.lastFinishedAt = '2026-08-09T11:59:00.000Z';
  const alerts = evaluateOperationalAlerts({
    previous,
    current,
    now: NOW,
    correlationId: '11111111-1111-4111-8111-111111111111',
    release: { compatible: false, expected_server_version: '0.14.0', observed_server_version: '0.13.2' },
  });
  assert.deepEqual(alerts.map((alert) => alert.code), ['reminder_scheduler_stale', 'release_version_mismatch']);
});
test('replaces caller aliases and drops non-allowlisted dimension values', () => {
  const previous = snapshot();
  const current = snapshot();
  const alerts = evaluateOperationalAlerts({
    previous,
    current,
    now: NOW,
    correlationId: 'privateEmailAlias',
    release: { compatible: false, expected_server_version: 'privateAlias', observed_server_version: 'anotherAlias' },
  });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].correlation_id, /^[a-f0-9-]{36}$/i);
  assert.notEqual(alerts[0].correlation_id, 'privateEmailAlias');
  assert.deepEqual(alerts[0].dimensions, {});
  assert.doesNotMatch(JSON.stringify(alerts), /privateEmailAlias|privateAlias|anotherAlias/);
});
test('gives a fresh process two scheduler intervals before declaring a missing run stale', () => {
  const previous = snapshot();
  const current = snapshot();
  current.process_started_at = '2026-08-09T11:59:00.000Z';
  current.background_jobs = {};
  assert.deepEqual(evaluate(previous, current), []);
});
test('reports auth request and refresh triggers independently without combined rates', () => {
  const previous = snapshot();
  const current = snapshot();
  current.requests.by_category.auth = { total: 50, serverFailures: 1 };
  current.operations.auth_mobile_refresh = { attempts: 20, failures: 1 };
  const alerts = evaluate(previous, current);
  assert.deepEqual(alerts.map((alert) => alert.code), [
    'auth_request_failure_warning',
    'auth_refresh_failure_warning',
  ]);
  assert.deepEqual(alerts.map(({ numerator, denominator, dimensions }) => ({
    numerator,
    denominator,
    dimensions,
  })), [
    { numerator: 1, denominator: 50, dimensions: { signal: 'auth_requests' } },
    { numerator: 1, denominator: 20, dimensions: { signal: 'auth_mobile_refresh' } },
  ]);
});
