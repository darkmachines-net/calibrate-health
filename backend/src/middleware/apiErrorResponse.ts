import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { safeErrorType, safeRequestId } from '../observability';

type ApiErrorBody = Record<string, unknown>;
type HttpError = Error & { statusCode?: number; status?: number };

const MAX_MESSAGE_LENGTH = 512;
const MAX_CODE_LENGTH = 96;
const MAX_FIELD_ERROR_COUNT = 16;
const MAX_FIELD_MESSAGES = 4;
const MAX_FIELD_MESSAGE_LENGTH = 256;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const UNSAFE_MESSAGE_PATTERN = /(?:<!doctype|<html|sqlstate|prisma|stack\s*trace|\b(?:select|insert|update|delete)\s+[^.]{0,80}\b(?:from|into|set|where)\b|\b(?:provider|upstream)\s+(?:error|response|failure|failed)|(?:authorization|cookie|password|secret|api[_-]?key)\s*[:=]|\bbearer\s+[A-Za-z0-9._~-]|(?:^|\s)at\s+\S+\s*\()/i;
const FOOD_DAY_STATUSES = new Set(['OPEN', 'COMPLETE', 'INCOMPLETE', 'PAUSED']);
const FOOD_DAY_ORIGINS = new Set(['USER', 'PAUSE', 'IMPORT']);
const FOOD_DAY_SOURCES = new Set([
  'STORED',
  'ACTIVE_PAUSE',
  'INFERRED_EMPTY',
  'DEFAULT',
  'BEFORE_TRACKING_START'
]);
const CURRENT_FOOD_DAY_STATUSES = new Set(['OPEN', 'COMPLETE', 'INCOMPLETE', 'PAUSED']);
const CURRENT_FOOD_DAY_SOURCES = new Set(['USER', 'PAUSE', 'IMPORT']);

const SAFE_SERVER_ERRORS: Readonly<Record<string, {
  status: number;
  message: string;
  retryable: boolean;
}>> = {
  NATIVE_PUSH_DISABLED: {
    status: 503,
    message: 'Native push is disabled by this server.',
    retryable: false
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedMessage(value: unknown, maximumLength = MAX_MESSAGE_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    // eslint-disable-next-line no-control-regex -- Reject control characters in public error text.
    /[\r\n\u0000-\u001f\u007f]/.test(normalized) ||
    UNSAFE_MESSAGE_PATTERN.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function normalizedCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length <= MAX_CODE_LENGTH && CODE_PATTERN.test(normalized)
    ? normalized
    : undefined;
}

function normalizedFieldErrors(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;

  const entries = Object.entries(value);
  if (
    entries.length > MAX_FIELD_ERROR_COUNT ||
    !entries.every(([field, messages]) =>
      FIELD_NAME_PATTERN.test(field) &&
      Array.isArray(messages) &&
      messages.length > 0 &&
      messages.length <= MAX_FIELD_MESSAGES &&
      messages.every((message) => normalizedMessage(message, MAX_FIELD_MESSAGE_LENGTH) !== undefined)
    )
  ) {
    return undefined;
  }

  return Object.fromEntries(entries.map(([field, messages]) => [
    field,
    (messages as string[]).map((message) => normalizedMessage(message, MAX_FIELD_MESSAGE_LENGTH)!)
  ]));
}

function isDateTimeValue(value: unknown): value is string | Date | null {
  return value === null || (
    value instanceof Date
      ? !Number.isNaN(value.getTime())
      : typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value))
  );
}

function normalizedVersion(value: unknown, nullable: boolean): string | null | undefined {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length <= 64 && VERSION_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizedFoodDay(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.date !== 'string' ||
    !LOCAL_DATE_PATTERN.test(value.date) ||
    typeof value.status !== 'string' ||
    !FOOD_DAY_STATUSES.has(value.status) ||
    !(value.origin === null || (typeof value.origin === 'string' && FOOD_DAY_ORIGINS.has(value.origin))) ||
    typeof value.source !== 'string' ||
    !FOOD_DAY_SOURCES.has(value.source) ||
    typeof value.is_representative !== 'boolean' ||
    typeof value.is_complete !== 'boolean' ||
    !isDateTimeValue(value.completed_at) ||
    !isDateTimeValue(value.updated_at)
  ) {
    return undefined;
  }

  return {
    date: value.date,
    status: value.status,
    origin: value.origin,
    source: value.source,
    is_representative: value.is_representative,
    is_complete: value.is_complete,
    completed_at: value.completed_at,
    updated_at: value.updated_at
  };
}

function normalizedRevision(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{16,128}$/i.test(value) ? value : undefined;
}

function normalizedCurrent(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const revision = normalizedRevision(value.revision);
  if (!revision) return undefined;

  if (
    typeof value.local_date === 'string' &&
    LOCAL_DATE_PATTERN.test(value.local_date) &&
    typeof value.weight_grams === 'number' &&
    Number.isSafeInteger(value.weight_grams) &&
    value.weight_grams > 0 &&
    value.weight_grams <= 1_000_000
  ) {
    return {
      local_date: value.local_date,
      weight_grams: value.weight_grams,
      revision
    };
  }

  if (
    typeof value.date === 'string' &&
    LOCAL_DATE_PATTERN.test(value.date) &&
    typeof value.status === 'string' &&
    CURRENT_FOOD_DAY_STATUSES.has(value.status) &&
    typeof value.source === 'string' &&
    CURRENT_FOOD_DAY_SOURCES.has(value.source) &&
    typeof value.is_representative === 'boolean' &&
    typeof value.is_complete === 'boolean' &&
    isDateTimeValue(value.completed_at)
  ) {
    return {
      date: value.date,
      status: value.status,
      source: value.source,
      is_representative: value.is_representative,
      is_complete: value.is_complete,
      completed_at: value.completed_at,
      revision
    };
  }

  return undefined;
}

function normalizedExtensions(
  statusCode: number,
  code: string,
  body: Record<string, unknown>
): ApiErrorBody {
  const extensions: ApiErrorBody = {};
  if (statusCode >= 500 && typeof body.ok === 'boolean') extensions.ok = body.ok;

  if (code === 'CLIENT_UPGRADE_REQUIRED') {
    const currentVersion = normalizedVersion(body.current_version, true);
    const minimumVersion = normalizedVersion(body.minimum_supported_version, false);
    if (
      (body.platform === 'android_phone' || body.platform === 'ios' || body.platform === 'wear_os') &&
      currentVersion !== undefined &&
      minimumVersion !== undefined
    ) {
      extensions.platform = body.platform;
      extensions.current_version = currentVersion;
      extensions.minimum_supported_version = minimumVersion;
    }
  }

  if (code === 'FOOD_DAY_NOT_OPEN') {
    const foodDay = normalizedFoodDay(body.food_day);
    if (foodDay !== undefined) extensions.food_day = foodDay;
  }

  if (code === 'ENTITY_CONFLICT') {
    const current = normalizedCurrent(body.current);
    if (current !== undefined) extensions.current = current;
  }

  return extensions;
}

function defaultCodeForStatus(statusCode: number): string {
  if (statusCode === 401) return 'NOT_AUTHENTICATED';
  if (statusCode === 403) return 'FORBIDDEN';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 409) return 'CONFLICT';
  if (statusCode === 413) return 'PAYLOAD_TOO_LARGE';
  if (statusCode === 429) return 'RATE_LIMITED';
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) return 'SERVICE_UNAVAILABLE';
  if (statusCode >= 500) return 'SERVER_ERROR';
  return 'INVALID_REQUEST';
}

function defaultMessageForStatus(statusCode: number): string {
  if (statusCode === 401) return 'Not authenticated';
  if (statusCode === 403) return 'Forbidden';
  if (statusCode === 404) return 'Not found';
  if (statusCode === 409) return 'Conflict';
  if (statusCode === 413) return 'Request body is too large';
  if (statusCode === 429) return 'Too many requests';
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) return 'Service unavailable';
  if (statusCode >= 500) return 'Server error';
  return 'Invalid request';
}

function defaultRetryableForStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

/** Add the current request's stable error envelope without mutating route/idempotency bodies. */
function normalizeApiErrorResponse(
  statusCode: number,
  body: unknown,
  requestId: string
): ApiErrorBody {
  const source = isRecord(body) ? body : {};
  const sourceCode = normalizedCode(source.code);
  const safeServerError = sourceCode ? SAFE_SERVER_ERRORS[sourceCode] : undefined;
  const useSafeServerError = statusCode >= 500 && safeServerError?.status === statusCode;
  let code = sourceCode ?? defaultCodeForStatus(statusCode);
  let message = normalizedMessage(source.message) ?? defaultMessageForStatus(statusCode);
  let retryable = typeof source.retryable === 'boolean'
    ? source.retryable
    : defaultRetryableForStatus(statusCode);

  if (useSafeServerError) {
    code = sourceCode!;
    message = safeServerError.message;
    retryable = safeServerError.retryable;
  } else if (statusCode >= 500) {
    code = defaultCodeForStatus(statusCode);
    message = defaultMessageForStatus(statusCode);
    retryable = defaultRetryableForStatus(statusCode);
  }

  const fieldErrors = statusCode < 500 ? normalizedFieldErrors(source.field_errors) : undefined;
  const normalized: ApiErrorBody = {
    ...normalizedExtensions(statusCode, code, source),
    message,
    code,
    retryable,
    request_id: requestId
  };

  if (fieldErrors) normalized.field_errors = fieldErrors;

  return normalized;
}

/** Normalize every later JSON error at the final serialization boundary. */
export function createApiErrorResponseMiddleware(): RequestHandler {
  return (_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode < 400) return originalJson(body);

      const requestId = safeRequestId(res.locals.requestId ?? res.getHeader('x-request-id'));
      res.locals.requestId = requestId;
      res.setHeader('x-request-id', requestId);
      return originalJson(normalizeApiErrorResponse(res.statusCode, body, requestId));
    }) as Response['json'];
    next();
  };
}

/** Keep unknown API and auth routes in the JSON contract before the SPA fallback. */
export const apiRouteNotFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ message: 'Not found' });
};

/** Final JSON error mapper for middleware and async route failures. */
export const apiRequestErrorHandler: ErrorRequestHandler = (err: HttpError, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const rawStatus = err.statusCode ?? err.status;
  const statusCode = typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
  if (statusCode >= 500) {
    console.error(
      `Unhandled request error (request_id=${res.locals.requestId ?? 'unavailable'}, error_type=${safeErrorType(err)}).`
    );
  }

  if (statusCode === 413) {
    res.status(statusCode).json({ message: 'Request body is too large' });
    return;
  }

  if (statusCode < 500) {
    // `expose` is not a trust boundary: body-parser and third-party middleware set it on
    // errors whose messages can contain request content or implementation details.
    res.status(statusCode).json({});
    return;
  }

  res.status(500).json({ message: 'Server error' });
};
