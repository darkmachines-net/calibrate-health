/** @file Provider barcode lookup normalization and immutable serving/attribution snapshots for food selection. */

import { normalizeSearchedFoodItem, type SearchedFoodItem } from '../food/serving';
import { getBarcodeLookupFailure } from './state';

const BARCODE_DUPLICATE_WINDOW_MS = 1_200;
const FATSECRET_URL = 'https://www.fatsecret.com';
const UPC_E_NUMBER_SYSTEMS = new Set(['0', '1']);

type BarcodeFormat = 'ean-8' | 'ean-13' | 'upc-a' | 'upc-e';
export type BarcodeFormatHint = BarcodeFormat | 'ean8' | 'ean13' | 'upc_a' | 'upc_e';

type NormalizedBarcode = {
    barcode: string;
    canonicalKey: string;
    format: BarcodeFormat;
};

export type BarcodeNormalizationResult =
    | ({ ok: true } & NormalizedBarcode)
    | {
          ok: false;
          reason: 'empty' | 'characters' | 'length' | 'checksum';
          message: string;
      };

export type CameraPermissionState = 'checking' | 'granted' | 'request' | 'settings';

export type BarcodeScanDecision =
    | { kind: 'accepted'; barcode: string }
    | { kind: 'duplicate' }
    | { kind: 'invalid'; message: string };

export type BarcodeRequestDecision =
    | ({ kind: 'accepted' } & NormalizedBarcode)
    | { kind: 'duplicate' }
    | { kind: 'invalid'; message: string };

export type BarcodeOperationDecision = 'accepted' | 'duplicate';

export type BarcodeLookupStatus =
    | 'idle'
    | 'searching'
    | 'result'
    | 'no-result'
    | 'offline'
    | 'auth-required'
    | 'error';

export type ProviderAttribution = {
    text: string;
    url?: string;
};

/**
 * Normalize every provider barcode match into the same selectable item used by text search.
 * The accepted barcode and missing response-level provider are retained in the immutable snapshot.
 */
export function resolveBarcodeFoodCandidates(
    values: unknown,
    barcode: string,
    provider?: string | null
): SearchedFoodItem[] {
    if (!Array.isArray(values)) return [];
    const snapshotBarcode = normalizeBarcode(barcode) ?? barcode.trim();
    const providerSource = provider?.trim() || null;
    return values.flatMap((value) => {
        const item = normalizeSearchedFoodItem(value);
        if (!item) return [];
        return [{
            ...item,
            source: item.source ?? providerSource,
            barcode: snapshotBarcode
        }];
    });
}

/** Decide whether the current platform can prompt again or must hand control to settings. */
export function getCameraPermissionState(
    permission: { granted: boolean; canAskAgain: boolean } | null
): CameraPermissionState {
    if (!permission) return 'checking';
    if (permission.granted) return 'granted';
    return permission.canAskAgain ? 'request' : 'settings';
}

function normalizeFormatHint(value?: BarcodeFormatHint): BarcodeFormat | null {
    if (!value) return null;
    const normalized = value.toLowerCase().replace('_', '-');
    if (normalized === 'ean8') return 'ean-8';
    if (normalized === 'ean13') return 'ean-13';
    if (
        normalized === 'ean-8'
        || normalized === 'ean-13'
        || normalized === 'upc-a'
        || normalized === 'upc-e'
    ) {
        return normalized;
    }
    return null;
}

function getCheckDigit(data: string): string {
    let total = 0;
    for (let index = data.length - 1, offset = 0; index >= 0; index -= 1, offset += 1) {
        total += Number(data[index]) * (offset % 2 === 0 ? 3 : 1);
    }
    return String((10 - (total % 10)) % 10);
}

function hasValidCheckDigit(barcode: string): boolean {
    return barcode.length > 1 && getCheckDigit(barcode.slice(0, -1)) === barcode[barcode.length - 1];
}

function expandUpcEData(upcEWithoutCheckDigit: string): string | null {
    if (upcEWithoutCheckDigit.length !== 7) return null;
    const [numberSystem, first, second, third, fourth, fifth, expansionDigit] = upcEWithoutCheckDigit;
    if (!UPC_E_NUMBER_SYSTEMS.has(numberSystem)) return null;

    if (expansionDigit === '0' || expansionDigit === '1' || expansionDigit === '2') {
        return `${numberSystem}${first}${second}${expansionDigit}0000${third}${fourth}${fifth}`;
    }
    if (expansionDigit === '3') {
        return `${numberSystem}${first}${second}${third}00000${fourth}${fifth}`;
    }
    if (expansionDigit === '4') {
        return `${numberSystem}${first}${second}${third}${fourth}00000${fifth}`;
    }
    return `${numberSystem}${first}${second}${third}${fourth}${fifth}0000${expansionDigit}`;
}

function normalizeUpcE(digits: string): NormalizedBarcode | null {
    let fullUpcE = digits;
    if (digits.length === 6) {
        const withoutCheck = `0${digits}`;
        const expandedData = expandUpcEData(withoutCheck);
        if (!expandedData) return null;
        fullUpcE = `${withoutCheck}${getCheckDigit(expandedData)}`;
    } else if (digits.length === 7) {
        if (UPC_E_NUMBER_SYSTEMS.has(digits[0])) {
            const expandedData = expandUpcEData(digits);
            if (!expandedData) return null;
            fullUpcE = `${digits}${getCheckDigit(expandedData)}`;
        } else {
            fullUpcE = `0${digits}`;
        }
    }
    if (fullUpcE.length !== 8) return null;

    const expandedData = expandUpcEData(fullUpcE.slice(0, -1));
    if (!expandedData || getCheckDigit(expandedData) !== fullUpcE[fullUpcE.length - 1]) return null;
    const expandedUpcA = `${expandedData}${fullUpcE[fullUpcE.length - 1]}`;
    return {
        barcode: fullUpcE,
        canonicalKey: expandedUpcA.padStart(14, '0'),
        format: 'upc-e'
    };
}

function normalizedCheckedBarcode(
    barcode: string,
    format: Exclude<BarcodeFormat, 'upc-e'>
): NormalizedBarcode | null {
    if (!hasValidCheckDigit(barcode)) return null;
    return {
        barcode,
        canonicalKey: barcode.padStart(14, '0'),
        format
    };
}

/** Normalize and checksum both manual and camera EAN/UPC input into one duplicate key. */
export function normalizeBarcodeInput(
    value: unknown,
    formatHint?: BarcodeFormatHint
): BarcodeNormalizationResult {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return { ok: false, reason: 'empty', message: 'Enter an EAN or UPC barcode.' };
    }
    const digits = value.trim().replace(/[\s-]+/g, '');
    if (!/^\d+$/.test(digits)) {
        return { ok: false, reason: 'characters', message: 'Use digits only for an EAN or UPC barcode.' };
    }
    if (![6, 7, 8, 12, 13].includes(digits.length)) {
        return {
            ok: false,
            reason: 'length',
            message: 'EAN and UPC barcodes contain 6, 7, 8, 12, or 13 digits.'
        };
    }

    const hint = normalizeFormatHint(formatHint);
    let normalized: NormalizedBarcode | null = null;
    if (digits.length === 6 || digits.length === 7 || hint === 'upc-e') {
        normalized = normalizeUpcE(digits);
    } else if (digits.length === 8) {
        // UPC-E starts with its number system. Prefer it without a camera hint so manual entry
        // and camera callbacks resolve the same canonical GTIN duplicate key.
        normalized = UPC_E_NUMBER_SYSTEMS.has(digits[0]) ? normalizeUpcE(digits) : null;
        normalized ??= normalizedCheckedBarcode(digits, 'ean-8');
    } else if (digits.length === 12) {
        normalized = normalizedCheckedBarcode(digits, 'upc-a');
    } else if (digits.length === 13) {
        normalized = normalizedCheckedBarcode(digits, 'ean-13');
    }

    if (!normalized) {
        return {
            ok: false,
            reason: 'checksum',
            message: 'That barcode check digit is not valid. Check the number and try again.'
        };
    }
    return { ok: true, ...normalized };
}

/** Compatibility helper returning the normalized provider lookup value. */
export function normalizeBarcode(value: unknown, formatHint?: BarcodeFormatHint): string | null {
    const result = normalizeBarcodeInput(value, formatHint);
    return result.ok ? result.barcode : null;
}

/** Canonical GTIN key makes UPC-A and its zero-prefixed EAN-13 representation equivalent. */
export function getBarcodeCanonicalKey(value: unknown, formatHint?: BarcodeFormatHint): string | null {
    const result = normalizeBarcodeInput(value, formatHint);
    return result.ok ? result.canonicalKey : null;
}

/**
 * Synchronously locks after an accepted scan so repeated native camera callbacks cannot launch
 * duplicate provider requests before React has committed the next render.
 */
export class BarcodeScanGate {
    private locked = false;
    private lastRawValue: string | null = null;
    private lastEventAt = Number.NEGATIVE_INFINITY;

    /** Creates a scan gate with an injectable clock and duplicate-scan suppression interval. */
    constructor(
        private readonly now: () => number = Date.now,
        private readonly duplicateWindowMs = BARCODE_DUPLICATE_WINDOW_MS
    ) {}

    /** Normalizes a scan, suppresses recent duplicates, and locks accepted work until reset. */
    accept(rawValue: unknown, formatHint?: BarcodeFormatHint): BarcodeScanDecision {
        const normalized = normalizeBarcodeInput(rawValue, formatHint);
        const comparableValue = normalized.ok
            ? normalized.canonicalKey
            : typeof rawValue === 'string'
                ? rawValue.trim().replace(/[\s-]+/g, '')
                : '';
        const eventAt = this.now();
        if (
            comparableValue.length > 0
            && comparableValue === this.lastRawValue
            && eventAt - this.lastEventAt < this.duplicateWindowMs
        ) {
            return { kind: 'duplicate' };
        }

        this.lastRawValue = comparableValue;
        this.lastEventAt = eventAt;
        if (this.locked) return { kind: 'duplicate' };

        if (!normalized.ok) {
            return { kind: 'invalid', message: normalized.message };
        }

        this.locked = true;
        return { kind: 'accepted', barcode: normalized.barcode };
    }

    /** Clears the scan lock and duplicate history so a new scan can be accepted. */
    reset(): void {
        this.locked = false;
        this.lastRawValue = null;
        this.lastEventAt = Number.NEGATIVE_INFINITY;
    }
}

/** Prevent duplicate provider requests before mutation state has propagated through React. */
export class BarcodeRequestGate {
    private activeCanonicalKey: string | null = null;

    /** Validates a barcode and claims the single active lookup, rejecting overlapping requests. */
    start(rawValue: unknown, formatHint?: BarcodeFormatHint): BarcodeRequestDecision {
        const normalized = normalizeBarcodeInput(rawValue, formatHint);
        if (!normalized.ok) return { kind: 'invalid', message: normalized.message };
        if (this.activeCanonicalKey !== null) return { kind: 'duplicate' };
        this.activeCanonicalKey = normalized.canonicalKey;
        return {
            kind: 'accepted',
            barcode: normalized.barcode,
            canonicalKey: normalized.canonicalKey,
            format: normalized.format
        };
    }

    /** Releases the active barcode lookup after its request finishes. */
    finish(): void {
        this.activeCanonicalKey = null;
    }

    /** Clears active lookup state when restarting the barcode workflow. */
    reset(): void {
        this.activeCanonicalKey = null;
    }
}

/** Keep a successful or in-flight submit locked until the editor intentionally resets. */
export class BarcodeSubmissionGate {
    private locked = false;

    /** Claims the logging operation once and rejects repeated submissions while locked. */
    start(): BarcodeOperationDecision {
        if (this.locked) return 'duplicate';
        this.locked = true;
        return 'accepted';
    }

    /** Unlocks a failed logging operation so the user can retry. */
    fail(): void {
        this.locked = false;
    }

    /** Keeps a successful logging operation locked to prevent duplicate submission. */
    complete(): void {
        this.locked = true;
    }

    /** Reopens the logging gate for a new workflow. */
    reset(): void {
        this.locked = false;
    }
}

/** Resolves lookup presentation with loaded results taking precedence over connectivity and request state. */
export function getBarcodeLookupStatus(options: {
    hasBarcode: boolean;
    isPending: boolean;
    isSuccess: boolean;
    hasResult: boolean;
    hasError: boolean;
    isOnline?: boolean;
    error?: unknown;
}): BarcodeLookupStatus {
    if (!options.hasBarcode) return 'idle';
    if (options.hasResult) return 'result';
    if (options.isOnline === false) return 'offline';
    if (options.isPending) return 'searching';
    if (options.hasError) {
        const failure = getBarcodeLookupFailure(options.error);
        if (failure.kind === 'offline') return 'offline';
        if (failure.kind === 'authentication') return 'auth-required';
        return 'error';
    }
    if (options.isSuccess) return 'no-result';
    return 'idle';
}

/** Convert transport/provider failures into actionable copy without exposing raw gateway responses. */
export function getBarcodeLookupErrorMessage(error: unknown): string {
    const failure = getBarcodeLookupFailure(error);
    if (failure.kind === 'offline') {
        return 'Could not reach your Calibrate server. Check your connection and try again.';
    }
    if (failure.kind === 'unknown') {
        return 'Barcode lookup failed. Try again or scan a different barcode.';
    }
    return failure.message;
}

function boundedProviderText(value?: string | null): string | null {
    const normalized = value?.trim().replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ');
    return normalized ? normalized.slice(0, 160) : null;
}

/** Preserve provider credit, including the required FatSecret attribution text and destination. */
export function getProviderAttribution(
    provider?: string | null,
    attribution?: string | null
): ProviderAttribution | null {
    const providerText = boundedProviderText(provider);
    const normalizedProvider = providerText?.toLowerCase();
    if (normalizedProvider === 'fatsecret') {
        return { text: 'Powered by fatsecret', url: FATSECRET_URL };
    }

    const explicitAttribution = boundedProviderText(attribution);
    if (explicitAttribution) return { text: explicitAttribution };
    if (!normalizedProvider || !providerText) return null;

    let providerLabel = providerText;
    if (normalizedProvider === 'openfoodfacts') providerLabel = 'Open Food Facts';
    if (normalizedProvider === 'usda') providerLabel = 'USDA FoodData Central';
    return { text: `Data from ${providerLabel}` };
}
