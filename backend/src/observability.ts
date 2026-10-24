/** @file observability: Process-local, bounded counters deliberately avoid user, route-parameter, and health-data labels. */

import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import {
  isClientDiagnosticRequestId,
  type ClientDiagnosticInput
} from '../../shared/clientDiagnostics';
const FORBIDDEN_FIELD_PATTERN = /(authorization|cookie|token|secret|password|email|user_?id|payload|query|body|food|weight|calorie|barcode|message|stack|url|path|route|exception)/i;
const SAFE_ERROR_TYPES: ReadonlySet<string> = new Set([
  'AbortError',
  'AggregateError',
  'CalibrationConflictError',
  'ClientOperationConflictError',
  'Error',
  'EvalError',
  'FetchError',
  'MyFoodsLibraryRequestError',
  'OnboardingDraftConflictError',
  'OnboardingDraftStateError',
  'PrismaClientInitializationError',
  'PrismaClientKnownRequestError',
  'PrismaClientRustPanicError',
  'PrismaClientUnknownRequestError',
  'PrismaClientValidationError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TokenClaimFailed',
  'TypeError',
  'URIError',
  'WatchTimezoneInvalidError'
]);
const ERROR_CONTEXT_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const LATENCY_BUCKETS_MS = [10, 50, 100, 500, 1_000, 5_000] as const;

export type DiagnosticCategory =
  | 'auth'
  | 'provider'
  | 'notification'
  | 'sync'
  | 'watch_reconciliation'
  | 'activity_reconciliation'
  | 'health'
  | 'diagnostics'
  | 'api_other'
  | 'frontend';

export type DiagnosticJobName = 'reminder_scheduler';
export type DiagnosticJobOutcome = 'success' | 'failure' | 'skipped';
export type DiagnosticOperationName =
  | 'notification_delivery'
  | 'auth_mobile_refresh'
  | 'food_provider_request'
  | 'health_connect_ingestion'
  | 'weight_trend_recompute'
  | 'watch_mutation_reconciliation';
export type DiagnosticOperationOutcome = 'success' | 'failure' | 'rejected' | 'conflict' | 'empty';

export type ObservabilityConfig = {
  enabled: boolean;
  metricsEnabled: boolean;
  metricsToken: string | null;
};

type RequestCounters = {
  total: number;
  failures: number;
  serverFailures: number;
  durationMsTotal: number;
  durationMsMax: number;
  latencyBuckets: Record<string, number>;
};

type JobCounters = {
  runs: number;
  successes: number;
  failures: number;
  skipped: number;
  durationMsTotal: number;
  durationMsMax: number;
  lastOutcome: DiagnosticJobOutcome | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
};

type ClientDiagnosticTupleCounter = Omit<ClientDiagnosticInput, 'request_id'> & { count: number };

type ClientDiagnosticCounters = {
  total: number;
  byTuple: Map<string, ClientDiagnosticTupleCounter>;
  byEvent: Map<string, number>;
  byOperation: Map<string, number>;
  byRoute: Map<string, number>;
  byPlatform: Map<string, number>;
  byVersion: Map<string, number>;
  byOutcome: Map<string, number>;
  byDurationBucket: Map<string, number>;
};

type OperationCounters = {
  attempts: number;
  successes: number;
  failures: number;
  rejected: number;
  conflicts: number;
  empty: number;
  durationSamples: number;
  durationMsTotal: number;
  durationMsMax: number;
  latencyBuckets: Record<string, number>;
};

const emptyRequestCounters = (): RequestCounters => ({
  total: 0,
  failures: 0,
  serverFailures: 0,
  durationMsTotal: 0,
  durationMsMax: 0,
  latencyBuckets: Object.fromEntries([...LATENCY_BUCKETS_MS.map((bucket) => [`up_to_${bucket}`, 0]), ['overflow', 0]])
});

const emptyJobCounters = (): JobCounters => ({
  runs: 0,
  successes: 0,
  failures: 0,
  skipped: 0,
  durationMsTotal: 0,
  durationMsMax: 0,
  lastOutcome: null,
  lastFinishedAt: null,
  lastSuccessAt: null
});

const emptyClientDiagnosticCounters = (): ClientDiagnosticCounters => ({
  total: 0,
  byTuple: new Map(),
  byEvent: new Map(),
  byOperation: new Map(),
  byRoute: new Map(),
  byPlatform: new Map(),
  byVersion: new Map(),
  byOutcome: new Map(),
  byDurationBucket: new Map()
});

const emptyOperationCounters = (): OperationCounters => ({
  attempts: 0,
  successes: 0,
  failures: 0,
  rejected: 0,
  conflicts: 0,
  empty: 0,
  durationSamples: 0,
  durationMsTotal: 0,
  durationMsMax: 0,
  latencyBuckets: Object.fromEntries([...LATENCY_BUCKETS_MS.map((bucket) => [`up_to_${bucket}`, 0]), ['overflow', 0]])
});

/** Process-local, bounded counters deliberately avoid user, route-parameter, and health-data labels. */
export class DiagnosticsRegistry {
  private readonly startedAt = new Date();
  private readonly requests = emptyRequestCounters();
  private readonly requestCategories = new Map<DiagnosticCategory, RequestCounters>();
  private readonly jobs = new Map<DiagnosticJobName, JobCounters>();
  private readonly operations = new Map<DiagnosticOperationName, OperationCounters>();
  private readonly clientDiagnostics = emptyClientDiagnosticCounters();

  /** Accumulate bounded request duration/status totals globally and within a fixed diagnostic category. */
  recordRequest(category: DiagnosticCategory, statusCode: number, durationMs: number): void {
    this.updateRequestCounters(this.requests, statusCode, durationMs);
    const counters = this.requestCategories.get(category) ?? emptyRequestCounters();
    this.updateRequestCounters(counters, statusCode, durationMs);
    this.requestCategories.set(category, counters);
  }

  /** Record a scheduler outcome and finish time, advancing successful-run freshness only on success. */
  recordJob(name: DiagnosticJobName, outcome: DiagnosticJobOutcome, durationMs: number): void {
    const counters = this.jobs.get(name) ?? emptyJobCounters();
    counters.runs += 1;
    counters.successes += outcome === 'success' ? 1 : 0;
    counters.failures += outcome === 'failure' ? 1 : 0;
    counters.skipped += outcome === 'skipped' ? 1 : 0;
    counters.durationMsTotal += boundedDuration(durationMs);
    counters.durationMsMax = Math.max(counters.durationMsMax, boundedDuration(durationMs));
    const finishedAt = new Date().toISOString();
    counters.lastOutcome = outcome;
    counters.lastFinishedAt = finishedAt;
    if (outcome === 'success') counters.lastSuccessAt = finishedAt;
    this.jobs.set(name, counters);
  }

  /** Count a fixed operation outcome; untimed attempts do not contribute latency samples. */
  recordOperation(name: DiagnosticOperationName, outcome: DiagnosticOperationOutcome, durationMs?: number): void {
    const counters = this.operations.get(name) ?? emptyOperationCounters();
    counters.attempts += 1;
    counters.successes += outcome === 'success' ? 1 : 0;
    counters.failures += outcome === 'failure' ? 1 : 0;
    counters.rejected += outcome === 'rejected' ? 1 : 0;
    counters.conflicts += outcome === 'conflict' ? 1 : 0;
    counters.empty += outcome === 'empty' ? 1 : 0;
    if (durationMs !== undefined) {
      const bounded = boundedDuration(durationMs);
      counters.durationSamples += 1;
      counters.durationMsTotal += bounded;
      counters.durationMsMax = Math.max(counters.durationMsMax, bounded);
      const bucket = LATENCY_BUCKETS_MS.find((limit) => bounded <= limit);
      counters.latencyBuckets[bucket === undefined ? 'overflow' : `up_to_${bucket}`] += 1;
    }
    this.operations.set(name, counters);
  }

  /** Aggregate an already-validated diagnostic by its bounded joint dimensions without retaining raw client data. */
  recordClientDiagnostic(diagnostic: ClientDiagnosticInput): void {
    this.clientDiagnostics.total += 1;
    const tupleKey = [
      diagnostic.event,
      diagnostic.operation,
      diagnostic.route,
      diagnostic.platform,
      diagnostic.version,
      diagnostic.outcome,
      diagnostic.duration_bucket
    ].join('\u001f');
    const currentTuple = this.clientDiagnostics.byTuple.get(tupleKey);
    this.clientDiagnostics.byTuple.set(tupleKey, {
      event: diagnostic.event,
      operation: diagnostic.operation,
      route: diagnostic.route,
      platform: diagnostic.platform,
      version: diagnostic.version,
      outcome: diagnostic.outcome,
      duration_bucket: diagnostic.duration_bucket,
      count: (currentTuple?.count ?? 0) + 1
    });
    incrementMap(this.clientDiagnostics.byEvent, diagnostic.event);
    incrementMap(this.clientDiagnostics.byOperation, diagnostic.operation);
    incrementMap(this.clientDiagnostics.byRoute, diagnostic.route);
    incrementMap(this.clientDiagnostics.byPlatform, diagnostic.platform);
    incrementMap(this.clientDiagnostics.byVersion, diagnostic.version);
    incrementMap(this.clientDiagnostics.byOutcome, diagnostic.outcome);
    incrementMap(this.clientDiagnostics.byDurationBucket, diagnostic.duration_bucket);
  }

  /** Copy process-local counters into stable wire aggregates with restart identity and no mutable registry references. */
  snapshot(): object {
    return {
      schema_version: 1,
      process_started_at: this.startedAt.toISOString(),
      process_uptime_seconds: Math.floor(process.uptime()),
      requests: {
        ...copyRequestCounters(this.requests),
        by_category: Object.fromEntries(
          [...this.requestCategories.entries()].sort(([left], [right]) => left.localeCompare(right))
            .map(([category, counters]) => [category, copyRequestCounters(counters)])
        )
      },
      background_jobs: Object.fromEntries(
        [...this.jobs.entries()].sort(([left], [right]) => left.localeCompare(right))
          .map(([name, counters]) => [name, { ...counters }])
      ),
      operations: Object.fromEntries(
        [...this.operations.entries()].sort(([left], [right]) => left.localeCompare(right))
          .map(([name, counters]) => [name, { ...counters, latencyBuckets: { ...counters.latencyBuckets } }])
      ),
      client_diagnostics: {
        total: this.clientDiagnostics.total,
        by_tuple: [...this.clientDiagnostics.byTuple.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, tuple]) => ({ ...tuple })),
        by_event: sortedMapObject(this.clientDiagnostics.byEvent),
        by_operation: sortedMapObject(this.clientDiagnostics.byOperation),
        by_route: sortedMapObject(this.clientDiagnostics.byRoute),
        by_platform: sortedMapObject(this.clientDiagnostics.byPlatform),
        by_version: sortedMapObject(this.clientDiagnostics.byVersion),
        by_outcome: sortedMapObject(this.clientDiagnostics.byOutcome),
        by_duration_bucket: sortedMapObject(this.clientDiagnostics.byDurationBucket)
      }
    };
  }

  private updateRequestCounters(counters: RequestCounters, statusCode: number, durationMs: number): void {
    const bounded = boundedDuration(durationMs);
    counters.total += 1;
    counters.failures += statusCode >= 400 ? 1 : 0;
    counters.serverFailures += statusCode >= 500 ? 1 : 0;
    counters.durationMsTotal += bounded;
    counters.durationMsMax = Math.max(counters.durationMsMax, bounded);
    const bucket = LATENCY_BUCKETS_MS.find((limit) => bounded <= limit);
    counters.latencyBuckets[bucket === undefined ? 'overflow' : `up_to_${bucket}`] += 1;
  }
}

function incrementMap(counters: Map<string, number>, key: string): void {
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

function sortedMapObject(counters: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counters.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value * 100) / 100, 86_400_000);
}

function copyRequestCounters(counters: RequestCounters): object {
  return { ...counters, latencyBuckets: { ...counters.latencyBuckets } };
}

export const diagnosticsRegistry = new DiagnosticsRegistry();

/** Map HTTP-style results to the fixed operation outcome set without introducing route-specific labels. */
export function diagnosticOperationOutcomeForStatus(statusCode: number): DiagnosticOperationOutcome {
  if (statusCode >= 200 && statusCode < 400) return 'success';
  if (statusCode === 409) return 'conflict';
  if (statusCode >= 400 && statusCode < 500) return 'rejected';
  return 'failure';
}

/** Enable logs explicitly and metrics only when a sufficiently long server-only bearer token is configured. */
export function resolveObservabilityConfig(env: NodeJS.ProcessEnv = process.env): ObservabilityConfig {
  const enabled = env.CALIBRATE_DIAGNOSTICS_ENABLED?.trim().toLowerCase() === 'true';
  const token = env.CALIBRATE_DIAGNOSTICS_METRICS_TOKEN?.trim() || null;
  return {
    enabled,
    metricsEnabled: enabled && token !== null && token.length >= 32,
    metricsToken: token
  };
}

/** Reduce a request URL to a fixed low-cardinality category; never retain its path or query as a label. */
export function classifyDiagnosticCategory(originalUrl: string): DiagnosticCategory {
  const path = originalUrl.split('?')[0]?.toLowerCase() ?? '';
  if (path.startsWith('/auth/')) return 'auth';
  const apiPath = path.replace(/^\/api(?:\/v1)?/, '');
  if (apiPath === '/healthz') return 'health';
  if (path === '/internal/diagnostics/metrics') return 'diagnostics';
  if (apiPath.startsWith('/watch')) return 'watch_reconciliation';
  if (apiPath.startsWith('/sync')) return 'sync';
  if (apiPath.startsWith('/activity')) return 'activity_reconciliation';
  if (apiPath.startsWith('/notifications')) return 'notification';
  if (apiPath.startsWith('/food/search') || apiPath.startsWith('/food/barcode') || apiPath.startsWith('/dev/food')) {
    return 'provider';
  }
  if (path.startsWith('/api/')) return 'api_other';
  return 'frontend';
}

/** Accept only bounded opaque trace identifiers, otherwise generate a replacement without echoing caller prose. */
export function safeRequestId(value: unknown, fallback: () => string = crypto.randomUUID): string {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (isClientDiagnosticRequestId(normalized)) return normalized;
  }
  return fallback();
}

/** Return only a bounded class name; exception messages and stacks may contain credentials or health data. */
export function safeErrorType(error: unknown): string {
  const candidate = error instanceof Error ? error.name : '';
  return SAFE_ERROR_TYPES.has(candidate) ? candidate : 'UnknownError';
}

/** Write a correlation-friendly operational error without serializing the exception itself. */
export function logSafeOperationalError(
  context: string,
  error: unknown,
  requestId?: unknown,
  write: (line: string) => void = console.error
): void {
  const safeContext = ERROR_CONTEXT_PATTERN.test(context) ? context : 'operation';
  const safeId = typeof requestId === 'string' && isClientDiagnosticRequestId(requestId) ? requestId : 'unavailable';
  write(`${safeContext} failed (request_id=${safeId}, error_type=${safeErrorType(error)}).`);
}

function safeMethod(value: string): string {
  const normalized = value.toUpperCase();
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(normalized)
    ? normalized
    : 'OTHER';
}

type DiagnosticValue = string | number | boolean | null | undefined;

function safeDiagnosticFieldValue(
  key: string,
  value: DiagnosticValue
): string | number | boolean | null | undefined {
  if (key === 'request_id' || key === 'correlation_id') {
    return typeof value === 'string' && isClientDiagnosticRequestId(value) ? value : '[REDACTED]';
  }
  if (key === 'method') return typeof value === 'string' ? safeMethod(value) : 'OTHER';
  if (key === 'category') {
    const allowed: ReadonlySet<DiagnosticCategory> = new Set([
      'auth', 'provider', 'notification', 'sync', 'watch_reconciliation',
      'activity_reconciliation', 'health', 'diagnostics', 'api_other', 'frontend'
    ]);
    return typeof value === 'string' && allowed.has(value as DiagnosticCategory) ? value : '[REDACTED]';
  }
  if (key === 'outcome') {
    const allowed = new Set([
      'success', 'failure', 'skipped', 'rejected', 'conflict', 'empty',
      'client_failure', 'server_failure'
    ]);
    return typeof value === 'string' && allowed.has(value) ? value : '[REDACTED]';
  }
  if (key === 'environment') {
    return typeof value === 'string' && ['development', 'test', 'staging', 'production'].includes(value)
      ? value
      : '[REDACTED]';
  }
  if (key === 'job') return value === 'reminder_scheduler' ? value : '[REDACTED]';
  if (key === 'schedule_source') return value === 'account_local_wall_clock' ? value : '[REDACTED]';
  if (key === 'error_type') {
    return typeof value === 'string' && SAFE_ERROR_TYPES.has(value) ? value : 'UnknownError';
  }
  if (['status_code', 'duration_ms', 'port', 'cors_origin_count', 'interval_minutes'].includes(key)) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
  if (['secure_cookies', 'metrics_enabled', 'reminder_scheduler_enabled'].includes(key)) {
    return typeof value === 'boolean' ? value : false;
  }
  return undefined;
}

/** Only established fixed fields survive; sensitive names are visibly redacted and unknown aliases are dropped. */
export function sanitizeDiagnosticFields(fields: Record<string, DiagnosticValue>): Record<string, string | number | boolean | null> {
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) continue;
    if (FORBIDDEN_FIELD_PATTERN.test(key)) {
      sanitized[key] = '[REDACTED]';
      continue;
    }
    if (value === undefined) continue;
    const safeValue = safeDiagnosticFieldValue(key, value);
    if (safeValue !== undefined) sanitized[key] = safeValue;
  }
  return sanitized;
}

/** Write one sanitized JSON event when enabled; discard fields outside the diagnostics allowlist. */
export function emitDiagnosticEvent(
  config: ObservabilityConfig,
  event: string,
  fields: Record<string, DiagnosticValue> = {},
  write: (line: string) => void = console.log
): void {
  if (!config.enabled) return;
  write(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    service: 'calibrate-backend',
    event: ERROR_CONTEXT_PATTERN.test(event) ? event : 'diagnostic.event',
    ...sanitizeDiagnosticFields(fields)
  }));
}

/** Attach opaque correlation headers and record sanitized completion timing without logging request payloads. */
export function createRequestObservabilityMiddleware(options: {
  config: ObservabilityConfig;
  registry?: DiagnosticsRegistry;
  nowNs?: () => bigint;
  write?: (line: string) => void;
}): RequestHandler {
  const registry = options.registry ?? diagnosticsRegistry;
  const nowNs = options.nowNs ?? process.hrtime.bigint;
  return (req, res, next) => {
    const requestId = safeRequestId(req.get('x-request-id'));
    const correlationId = safeRequestId(req.get('x-correlation-id'), () => requestId);
    const category = classifyDiagnosticCategory(req.originalUrl || req.url);
    const startedAt = nowNs();
    res.locals.requestId = requestId;
    res.locals.correlationId = correlationId;
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-correlation-id', correlationId);
    res.once('finish', () => {
      const durationMs = Number(nowNs() - startedAt) / 1_000_000;
      registry.recordRequest(category, res.statusCode, durationMs);
      emitDiagnosticEvent(options.config, 'http.request.completed', {
        request_id: requestId,
        correlation_id: correlationId,
        method: safeMethod(req.method),
        category,
        status_code: res.statusCode,
        duration_ms: boundedDuration(durationMs),
        outcome: res.statusCode >= 500 ? 'server_failure' : res.statusCode >= 400 ? 'client_failure' : 'success'
      }, options.write);
    });
    next();
  };
}

function metricsTokenMatches(header: string | undefined, configuredToken: string): boolean {
  const supplied = header?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(configuredToken);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Expose uncached aggregate counters only behind configured bearer authentication; hide disabled metrics with 404. */
export function createDiagnosticsMetricsHandler(options: {
  config: ObservabilityConfig;
  registry?: DiagnosticsRegistry;
}): RequestHandler {
  const registry = options.registry ?? diagnosticsRegistry;
  return (req, res) => {
    if (!options.config.metricsEnabled || !options.config.metricsToken) {
      res.status(404).json({ message: 'Not found' });
      return;
    }
    if (!metricsTokenMatches(req.get('authorization'), options.config.metricsToken)) {
      res.setHeader('www-authenticate', 'Bearer');
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    res.setHeader('cache-control', 'no-store');
    res.json(registry.snapshot());
  };
}
