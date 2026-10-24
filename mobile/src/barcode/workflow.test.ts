/** @file Regression coverage for workflow: barcode workflow. */

import {
    BarcodeScanGate,
    getBarcodeLookupErrorMessage,
    getBarcodeLookupStatus,
    getCameraPermissionState,
    getProviderAttribution,
    normalizeBarcode,
    resolveBarcodeFoodCandidates
} from './workflow';

describe('barcode workflow', () => {
    it('routes denied permissions to retry or platform settings based on canAskAgain', () => {
        expect(getCameraPermissionState(null)).toBe('checking');
        expect(getCameraPermissionState({ granted: true, canAskAgain: true })).toBe('granted');
        expect(getCameraPermissionState({ granted: false, canAskAgain: true })).toBe('request');
        expect(getCameraPermissionState({ granted: false, canAskAgain: false })).toBe('settings');
    });

    it('normalizes supported EAN/UPC values without dropping leading zeroes', () => {
        expect(normalizeBarcode(' 012345678905 ')).toBe('012345678905');
        expect(normalizeBarcode('12345670')).toBe('12345670');
        expect(normalizeBarcode('12345')).toBeNull();
        expect(normalizeBarcode('1234ABC89012')).toBeNull();
        expect(normalizeBarcode(undefined)).toBeNull();
    });

    it('debounces duplicate callbacks synchronously and accepts the code again after rescan', () => {
        let now = 100;
        const gate = new BarcodeScanGate(() => now);

        expect(gate.accept('012345678905')).toEqual({ kind: 'accepted', barcode: '012345678905' });
        expect(gate.accept('012345678905')).toEqual({ kind: 'duplicate' });
        now += 2_000;
        expect(gate.accept('123456789012')).toEqual({ kind: 'duplicate' });

        gate.reset();
        expect(gate.accept('012345678905')).toEqual({ kind: 'accepted', barcode: '012345678905' });
    });

    it('rejects malformed events without permanently locking the scanner', () => {
        let now = 100;
        const gate = new BarcodeScanGate(() => now);

        expect(gate.accept('not-a-barcode')).toMatchObject({ kind: 'invalid' });
        expect(gate.accept('not-a-barcode')).toEqual({ kind: 'duplicate' });
        now += 2_000;
        expect(gate.accept('012345678905')).toEqual({ kind: 'accepted', barcode: '012345678905' });
    });

    it('distinguishes searching, no-result, provider failure, and result states', () => {
        expect(getBarcodeLookupStatus({ hasBarcode: false, isPending: false, isSuccess: true, hasResult: false, hasError: false })).toBe('idle');
        expect(getBarcodeLookupStatus({ hasBarcode: true, isPending: true, isSuccess: false, hasResult: false, hasError: false })).toBe('searching');
        expect(getBarcodeLookupStatus({ hasBarcode: true, isPending: false, isSuccess: true, hasResult: false, hasError: false })).toBe('no-result');
        expect(getBarcodeLookupStatus({ hasBarcode: true, isPending: false, isSuccess: false, hasResult: false, hasError: true })).toBe('error');
        expect(getBarcodeLookupStatus({ hasBarcode: true, isPending: false, isSuccess: true, hasResult: true, hasError: false })).toBe('result');
    });

    it('turns provider and network failures into actionable messages', () => {
        expect(getBarcodeLookupErrorMessage({ status: 503 })).toMatch(/providers are unavailable/i);
        expect(getBarcodeLookupErrorMessage(new Error('Network request failed'))).toMatch(/Calibrate server/i);
        expect(getBarcodeLookupErrorMessage(new Error('unexpected'))).toMatch(/scan a different barcode/i);
    });

    it('preserves exact FatSecret attribution and labels other providers', () => {
        expect(getProviderAttribution('fatsecret')).toEqual({
            text: 'Powered by fatsecret',
            url: 'https://www.fatsecret.com'
        });
        expect(getProviderAttribution('openFoodFacts')).toEqual({ text: 'Data from Open Food Facts' });
        expect(getProviderAttribution(undefined, 'Provider attribution')).toEqual({ text: 'Provider attribution' });
    });

    it('normalizes every provider match and keeps the scanned barcode for the quantity editor', () => {
        const matches = resolveBarcodeFoodCandidates([
            {
                id: 'provider-food-1',
                source: 'openFoodFacts',
                description: 'Greek yogurt',
                brand: 'Example Dairy',
                availableMeasures: [
                    { label: 'per 100g', gramWeight: 100, quantity: 100, unit: 'g' },
                    { label: '1 container', gramWeight: 170, quantity: 1, unit: 'container' }
                ],
                nutrientsPer100g: { calories: 59 }
            },
            { id: 'provider-food-2', description: 'Vanilla yogurt', availableMeasures: [] },
            { malformed: true }
        ], '012345678905');

        expect(matches).toHaveLength(2);
        expect(matches[0]).toMatchObject({
                name: 'Greek yogurt',
                brand: 'Example Dairy',
                barcode: '012345678905',
                measures: [
                    { label: 'grams', gramWeight: 1, quantity: 1, unit: 'g' },
                    { label: '1 container', gramWeight: 170, quantity: 1, unit: 'container' }
                ]
        });
        expect(matches[1]).toMatchObject({ name: 'Vanilla yogurt', barcode: '012345678905' });
    });

    it('keeps partial provider matches selectable so the shared editor can explain missing serving data', () => {
        const matches = resolveBarcodeFoodCandidates([
            {
                id: 'partial-food',
                source: 'openFoodFacts',
                description: 'Mystery snack',
                brand: 'Corner Market',
                availableMeasures: []
            }
        ], '012345678905');

        expect(matches).toEqual([
            expect.objectContaining({
                name: 'Mystery snack',
                brand: 'Corner Market',
                measures: []
            })
        ]);
    });
});
