/** @file my Foods Utils: Utilities for the `/api/my-foods` routes. */

/**
 * Utilities for the `/api/my-foods` routes.
 *
 * This file intentionally avoids importing Prisma so unit tests can exercise input
 * normalization and error mapping without requiring DATABASE_URL or a running DB.
 */

export const SERVING_UNIT_LABEL_MAX_LENGTH = 48;
export const MY_FOOD_NAME_MAX_LENGTH = 120;

const MULTI_SPACE_PATTERN = /\s+/g;

/**
 * Normalize a free-form serving unit label for storage and validation.
 *
 * We avoid enforcing an enum so users can type locale-appropriate units ("g", "ml", "fl oz", "slice", etc.).
 */
export function normalizeServingUnitLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(MULTI_SPACE_PATTERN, ' ');
  if (!trimmed) return null;
  if (trimmed.length > SERVING_UNIT_LABEL_MAX_LENGTH) return null;
  return trimmed;
}

/**
 * Normalize a user-defined food/recipe name for storage.
 */
export function normalizeMyFoodName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(MULTI_SPACE_PATTERN, ' ');
  if (!trimmed) return null;
  if (trimmed.length > MY_FOOD_NAME_MAX_LENGTH) return null;
  return trimmed;
}

/**
 * Normalize an optional string field (trim, treat empty as "not provided").
 */
export function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export type HttpError = Error & { statusCode: number };

/**
 * Create a typed HTTP error so route handlers can map validation failures to status codes
 * without leaking stack traces or turning everything into a 500.
 */
export function createHttpError(statusCode: number, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  return err;
}

/**
 * Narrow unknown errors into our lightweight HttpError shape.
 */
export function isHttpError(value: unknown): value is HttpError {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.statusCode === 'number';
}

