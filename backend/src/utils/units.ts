/** @file units: Unit parsing + conversion helpers for API payloads and storage. */

/**
 * Unit parsing + conversion helpers for API payloads and storage.
 *
 * This keeps rounding and accepted unit labels consistent across routes.
 */
export type WeightUnit = 'KG' | 'LB';
export type HeightUnit = 'CM' | 'FT_IN';

// Precise pounds-to-grams conversion constant used for storage math.
const LB_TO_GRAMS = 453.59237;

/**
 * Type guard for supported weight unit preference values.
 */
export function isWeightUnit(value: unknown): value is WeightUnit {
  return value === 'KG' || value === 'LB';
}

/**
 * Type guard for supported height unit preference values.
 */
export function isHeightUnit(value: unknown): value is HeightUnit {
  return value === 'CM' || value === 'FT_IN';
}

/**
 * Parse a weight input (string/number) into grams for storage.
 *
 * We round to the nearest 0.1 in the source unit to match UI precision before converting to grams.
 */
export function parseWeightToGrams(input: unknown, unit: WeightUnit): number {
  const numeric =
    typeof input === 'number' ? input : typeof input === 'string' ? Number(input) : Number.NaN;

  if (!Number.isFinite(numeric)) {
    throw new Error('Invalid weight');
  }

  // Keep storage aligned with UI precision (1 decimal place).
  const roundedToTenth = Math.round(numeric * 10) / 10;
  if (roundedToTenth <= 0) {
    throw new Error('Weight must be positive');
  }

  const grams = unit === 'KG' ? roundedToTenth * 1000 : roundedToTenth * LB_TO_GRAMS;
  return Math.round(grams);
}

/**
 * Convert grams back into the user's preferred weight unit with 1 decimal place.
 */
export function gramsToWeight(grams: number, unit: WeightUnit): number {
  if (!Number.isFinite(grams)) {
    throw new Error('Invalid weight');
  }

  const weight = unit === 'KG' ? grams / 1000 : grams / LB_TO_GRAMS;
  return Math.round(weight * 10) / 10;
}
