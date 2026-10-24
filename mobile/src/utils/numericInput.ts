/** @file Localized numeric input parsing and canonical decimal validation for client forms. */

const MAX_INPUT_DECIMAL_PLACES = 6; // Matches the precision used by food serving snapshots.

/** Accept the decimal separator emitted by localized mobile number keyboards. */
export function normalizeDecimalInput(value: string): string {
    if (value.includes('.')) return value;
    return value.replace(',', '.');
}

/** Parses normalized decimal input and returns NaN for blank text. */
export function parseDecimalInput(value: string): number {
    const normalized = normalizeDecimalInput(value).trim();
    if (!normalized) return Number.NaN;
    return Number(normalized);
}

function getDecimalPlaces(value: string | number): number {
    const normalized = normalizeDecimalInput(String(value)).toLowerCase();
    const [coefficient, exponentText] = normalized.split('e');
    const coefficientPlaces = coefficient.includes('.')
        ? coefficient.length - coefficient.indexOf('.') - 1
        : 0;
    const exponent = exponentText ? Number(exponentText) : 0;
    return Math.max(0, coefficientPlaces - exponent);
}

/** Formats decimal input at bounded precision and removes unnecessary trailing fractional zeros. */
export function formatDecimalInput(value: number, decimalPlaces = MAX_INPUT_DECIMAL_PLACES): string {
    const boundedDecimalPlaces = Math.max(0, Math.min(MAX_INPUT_DECIMAL_PLACES, decimalPlaces));
    const fixedValue = value.toFixed(boundedDecimalPlaces);
    return boundedDecimalPlaces === 0 ? fixedValue : fixedValue.replace(/\.?0+$/, '');
}

/** Applies a numeric step to input, treating invalid text as zero and respecting optional bounds. */
export function adjustDecimalInput(options: {
    value: string;
    delta: number;
    min?: number;
    max?: number;
}): string {
    const parsed = parseDecimalInput(options.value);
    const currentValue = Number.isFinite(parsed) ? parsed : 0;
    let nextValue = currentValue + options.delta;
    if (typeof options.min === 'number') nextValue = Math.max(options.min, nextValue);
    if (typeof options.max === 'number') nextValue = Math.min(options.max, nextValue);

    const decimalPlaces = Math.min(
        MAX_INPUT_DECIMAL_PLACES,
        Math.max(
            getDecimalPlaces(options.value),
            getDecimalPlaces(options.delta),
            getDecimalPlaces(options.min ?? 0),
            getDecimalPlaces(options.max ?? 0)
        )
    );
    const scale = 10 ** decimalPlaces;
    const roundedValue = Math.round((nextValue + Number.EPSILON) * scale) / scale;
    return formatDecimalInput(roundedValue, decimalPlaces);
}
