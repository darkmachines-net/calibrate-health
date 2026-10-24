/** @file Exercises operational alert evaluation with deterministic synthetic inputs. */

import assert from 'node:assert/strict';
import { dispatchOperationalAlerts } from './operational-alerts.mjs';

const processStartedAt = '2026-08-09T10:00:00.000Z';
const healthyJob = { reminder_scheduler: { lastFinishedAt: '2026-08-09T11:55:00.000Z', lastSuccessAt: '2026-08-09T11:55:00.000Z' } };
const previous = {
  process_started_at: processStartedAt,
  requests: { total: 0, serverFailures: 0, by_category: {} },
  operations: {},
  client_diagnostics: { by_tuple: [] },
  background_jobs: healthyJob,
};
const current = {
  ...previous,
  operations: { food_provider_request: { attempts: 20, failures: 2 } },
};
const captured = [];
const fakeSink = { send: async (alert) => captured.push(alert) };

const alerts = await dispatchOperationalAlerts({
  previous,
  current,
  now: new Date('2026-08-09T12:00:00.000Z'),
  correlationId: '22222222-2222-4222-8222-222222222222',
}, fakeSink);

assert.equal(alerts.length, 1);
assert.deepEqual(captured, alerts);
assert.equal(alerts[0].code, 'provider_failure_warning');
assert.equal(alerts[0].owner_role, 'backend_maintainer');
assert.doesNotMatch(JSON.stringify(captured), /email|token|url|path|food_name|weight|calorie|barcode|payload/i);
console.log('[synthetic-alert] PASS: production threshold evaluator delivered one privacy-safe alert to the in-memory fake sink.');
console.log('[synthetic-alert] No staging or external alert provider was contacted.');
