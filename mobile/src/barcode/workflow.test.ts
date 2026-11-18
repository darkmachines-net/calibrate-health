/** @file Regression coverage for workflow: barcode workflow. */

import {
    getProviderAttribution,
    normalizeBarcode,
    resolveBarcodeFoodCandidates
} from './workflow';

describe('barcode workflow', () => {
    it('normalizes supported EAN/UPC values without dropping leading zeroes', () => {
        expect(normalizeBarcode(' 012345678905 ')).toBe('012345678905');
        expect(normalizeBarcode('12345670')).toBe('12345670');
        expect(normalizeBarcode('12345')).toBeNull();
        expect(normalizeBarcode('1234ABC89012')).toBeNull();
        expect(normalizeBarcode(undefined)).toBeNull();
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
