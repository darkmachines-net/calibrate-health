/** @file Regression coverage for workflow Recovery: barcode workflow recovery. */

import { buildSearchedFoodLogPayload } from '../food/serving';
import {
    BarcodeRequestGate,
    BarcodeSubmissionGate,
    normalizeBarcode,
    normalizeBarcodeInput,
    resolveBarcodeFoodCandidates
} from './workflow';

describe('barcode workflow recovery', () => {
    it('normalizes manual separators and validates standard EAN/UPC check digits', () => {
        expect(normalizeBarcodeInput(' 0 12345-67890 5 ')).toEqual({
            ok: true,
            barcode: '012345678905',
            canonicalKey: '00012345678905',
            format: 'upc-a'
        });
        expect(normalizeBarcode('4006381333931')).toBe('4006381333931');
        expect(normalizeBarcode('96385074', 'ean8')).toBe('96385074');
        expect(normalizeBarcodeInput('012345678904')).toMatchObject({
            ok: false,
            reason: 'checksum'
        });
        expect(normalizeBarcodeInput('0123-ABC-8905')).toMatchObject({
            ok: false,
            reason: 'characters'
        });
    });

    it('completes compact UPC-E input and canonicalizes its expanded GTIN', () => {
        expect(normalizeBarcodeInput('421000', 'upc_e')).toEqual({
            ok: true,
            barcode: '04210007',
            canonicalKey: '00042000001007',
            format: 'upc-e'
        });
        expect(normalizeBarcodeInput('04210007', 'upc_e')).toMatchObject({
            ok: true,
            canonicalKey: '00042000001007'
        });
        expect(normalizeBarcodeInput('042000001007', 'upc_a')).toMatchObject({
            ok: true,
            canonicalKey: '00042000001007'
        });
    });

    it('suppresses concurrent lookup requests but permits an intentional retry after settlement', () => {
        const gate = new BarcodeRequestGate();
        expect(gate.start('012345678905')).toMatchObject({
            kind: 'accepted',
            canonicalKey: '00012345678905'
        });
        expect(gate.start('0012345678905')).toEqual({ kind: 'duplicate' });
        gate.finish();
        expect(gate.start('0012345678905')).toMatchObject({ kind: 'accepted' });
    });

    it('keeps a log submit locked through success and unlocks only for failure or reset', () => {
        const gate = new BarcodeSubmissionGate();
        expect(gate.start()).toBe('accepted');
        expect(gate.start()).toBe('duplicate');
        gate.fail();
        expect(gate.start()).toBe('accepted');
        gate.complete();
        expect(gate.start()).toBe('duplicate');
        gate.reset();
        expect(gate.start()).toBe('accepted');
    });

    it('overrides provider echo data with the accepted barcode and preserves serving snapshots', () => {
        const [candidate] = resolveBarcodeFoodCandidates([{
            id: 'provider-food',
            description: 'Packaged food',
            barcode: '4006381333931',
            availableMeasures: [{
                label: '1 package',
                gramWeight: 45,
                quantity: 1,
                unit: 'package'
            }],
            nutrientsPer100g: { calories: 200 }
        }], '012345678905', 'openFoodFacts');

        expect(candidate).toMatchObject({
            source: 'openFoodFacts',
            barcode: '012345678905'
        });
        const result = buildSearchedFoodLogPayload({
            item: candidate,
            measure: candidate.measures[0],
            quantity: 2,
            date: '2026-08-09',
            meal: 'LUNCH'
        });
        expect(result).toMatchObject({
            ok: true,
            payload: {
                external_source: 'openFoodFacts',
                external_id: 'provider-food',
                barcode: '012345678905',
                serving_size_quantity_snapshot: 1,
                serving_unit_label_snapshot: 'package',
                measure_label: '1 package',
                grams_per_measure_snapshot: 45,
                measure_quantity_snapshot: 2,
                grams_total_snapshot: 90
            }
        });
    });
});
