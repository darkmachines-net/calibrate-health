/** @file Strict diagnostic payload validation and bounded privacy-safe operational aggregation. */

import type {
  ClientDiagnosticDurationBucket,
  ClientDiagnosticEvent,
  ClientDiagnosticInput,
  ClientDiagnosticOperation,
  ClientDiagnosticOutcome,
  ClientDiagnosticPlatform,
  ClientDiagnosticRoute
} from '../../../shared/clientDiagnostics';
import {
  CLIENT_DIAGNOSTIC_DURATION_BUCKETS,
  CLIENT_DIAGNOSTIC_EVENTS,
  CLIENT_DIAGNOSTIC_OPERATIONS,
  CLIENT_DIAGNOSTIC_OUTCOMES,
  CLIENT_DIAGNOSTIC_PLATFORMS,
  CLIENT_DIAGNOSTIC_ROUTES,
  isClientDiagnosticRequestId
} from '../../../shared/clientDiagnostics';
import diagnosticVersions from '../../../shared/client-diagnostic-versions.json';
import type { ObservabilityConfig } from '../observability';


const ALLOWED_KEYS = new Set([
  'event',
  'operation',
  'route',
  'platform',
  'version',
  'outcome',
  'duration_bucket',
  'request_id'
]);
const REQUIRED_KEYS = [...ALLOWED_KEYS].filter((key) => key !== 'request_id');
const EVENT_SET = new Set<string>(CLIENT_DIAGNOSTIC_EVENTS);
const OPERATION_SET = new Set<string>(CLIENT_DIAGNOSTIC_OPERATIONS);
const ROUTE_SET = new Set<string>(CLIENT_DIAGNOSTIC_ROUTES);
const PLATFORM_SET = new Set<string>(CLIENT_DIAGNOSTIC_PLATFORMS);
const OUTCOME_SET = new Set<string>(CLIENT_DIAGNOSTIC_OUTCOMES);
const DURATION_BUCKET_SET = new Set<string>(CLIENT_DIAGNOSTIC_DURATION_BUCKETS);
const VERSION_SETS: Record<ClientDiagnosticPlatform, ReadonlySet<string>> = {
  web: new Set(diagnosticVersions.supported_versions.web),
  android_phone: new Set(diagnosticVersions.supported_versions.android_phone),
  ios: new Set(diagnosticVersions.supported_versions.ios),
  wear_os: new Set(diagnosticVersions.supported_versions.wear_os)
};

const FEATURE_OPERATION_ROUTES: Partial<Record<ClientDiagnosticOperation, ClientDiagnosticRoute>> = {
  onboarding_complete: 'onboarding',
  food_copy: 'today',
  saved_foods_load: 'saved_foods',
  notification_history_page: 'notifications',
  weight_trend_load: 'progress'
};
const WEB_VITAL_OPERATIONS = new Set<ClientDiagnosticOperation>([
  'largest_contentful_paint',
  'interaction_to_next_paint',
  'cumulative_layout_shift'
]);
const WEB_VITAL_OUTCOMES = new Set<ClientDiagnosticOutcome>(['good', 'needs_improvement', 'poor']);
const WEB_VITAL_BUCKET_OUTCOMES: Partial<
  Record<ClientDiagnosticOperation, Partial<Record<ClientDiagnosticDurationBucket, ClientDiagnosticOutcome>>>
> = {
  largest_contentful_paint: {
    under_100_ms: 'good',
    '100_to_200_ms': 'good',
    '200_to_500_ms': 'good',
    '500_ms_to_1_s': 'good',
    '1_to_2_5_s': 'good',
    '2_5_to_4_s': 'needs_improvement',
    '4_s_or_more': 'poor'
  },
  interaction_to_next_paint: {
    under_100_ms: 'good',
    '100_to_200_ms': 'good',
    '200_to_500_ms': 'needs_improvement',
    '500_ms_to_1_s': 'poor',
    '1_to_2_5_s': 'poor',
    '2_5_to_4_s': 'poor',
    '4_s_or_more': 'poor'
  }
};

export type ClientDiagnosticParseResult =
  | { ok: true; value: ClientDiagnosticInput }
  | { ok: false };


function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | null {
  return typeof value === 'string' && allowed.has(value) ? value as T : null;
}

function isRegisteredTuple(value: ClientDiagnosticInput): boolean {
  if (!VERSION_SETS[value.platform].has(value.version)) return false;

  if (value.event === 'client_failure') {
    return value.operation === 'root_render'
      && value.route === 'app_shell'
      && value.outcome === 'failure'
      && value.duration_bucket === 'not_applicable';
  }

  if (value.event === 'operation_failure') {
    return FEATURE_OPERATION_ROUTES[value.operation] === value.route
      && value.outcome === 'failure'
      && value.duration_bucket === 'not_applicable';
  }

  if (value.event === 'degraded_result') {
    return value.operation === 'weight_trend_load'
      && value.route === 'progress'
      && value.outcome === 'degraded'
      && value.duration_bucket === 'not_applicable';
  }

  if (value.platform !== 'web'
    || !WEB_VITAL_OPERATIONS.has(value.operation)
    || !WEB_VITAL_OUTCOMES.has(value.outcome)) return false;
  if (value.operation === 'cumulative_layout_shift') {
    return value.duration_bucket === 'not_applicable';
  }
  return WEB_VITAL_BUCKET_OUTCOMES[value.operation]?.[value.duration_bucket] === value.outcome;
}

/** Reject every unknown or free-form field before it can reach metrics or logs. */
export function parseClientDiagnosticInput(body: unknown): ClientDiagnosticParseResult {
  if (!isPlainRecord(body)) return { ok: false };
  const keys = Object.keys(body);
  if (keys.some((key) => !ALLOWED_KEYS.has(key)) || REQUIRED_KEYS.some((key) => !(key in body))) {
    return { ok: false };
  }

  const event = enumValue<ClientDiagnosticEvent>(body.event, EVENT_SET);
  const operation = enumValue<ClientDiagnosticOperation>(body.operation, OPERATION_SET);
  const route = enumValue<ClientDiagnosticRoute>(body.route, ROUTE_SET);
  const platform = enumValue<ClientDiagnosticPlatform>(body.platform, PLATFORM_SET);
  const outcome = enumValue<ClientDiagnosticOutcome>(body.outcome, OUTCOME_SET);
  const durationBucket = enumValue<ClientDiagnosticDurationBucket>(body.duration_bucket, DURATION_BUCKET_SET);
  if (!event || !operation || !route || !platform || !outcome || !durationBucket || typeof body.version !== 'string') {
    return { ok: false };
  }

  let requestId: string | undefined;
  if ('request_id' in body) {
    if (!isClientDiagnosticRequestId(body.request_id)) return { ok: false };
    requestId = body.request_id;
  }

  const value: ClientDiagnosticInput = {
    event,
    operation,
    route,
    platform,
    version: body.version,
    outcome,
    duration_bucket: durationBucket,
    ...(requestId ? { request_id: requestId } : {})
  };
  return isRegisteredTuple(value) ? { ok: true, value } : { ok: false };
}

/** Emit only the already-validated fixed registry dimensions and one opaque correlation ID. */
export function emitClientDiagnostic(
  config: ObservabilityConfig,
  diagnostic: ClientDiagnosticInput,
  submissionRequestId: string,
  write: (line: string) => void = console.log
): void {
  if (!config.enabled) return;
  write(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    service: 'calibrate-backend',
    event: 'client.diagnostic',
    diagnostic_event: diagnostic.event,
    operation: diagnostic.operation,
    route: diagnostic.route,
    platform: diagnostic.platform,
    version: diagnostic.version,
    outcome: diagnostic.outcome,
    duration_bucket: diagnostic.duration_bucket,
    request_id: diagnostic.request_id ?? submissionRequestId
  }));
}
