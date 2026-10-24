/** @file Regression coverage for auth Return: barcode auth return. */

import { MEAL_PERIODS } from '@calibrate/shared';
import { createBarcodeLoginDestination, resolveBarcodeAuthDestination, type BarcodeAuthReturnParams } from './authReturn';
import { BARCODE_RESUME_STEPS, BARCODE_RETURN_DESTINATIONS } from './context';

const validParams = {
    barcodeAuthReturn: 'barcode',
    date: '2026-08-09',
    meal: MEAL_PERIODS.DINNER,
    returnTo: BARCODE_RETURN_DESTINATIONS.FOOD_LOG,
    barcodeResume: BARCODE_RESUME_STEPS.LOOKUP,
    barcode: '012345678905'
};

describe('barcode auth return', () => {
    it('round-trips only structured context to the canonical barcode route', () => {
        const login = createBarcodeLoginDestination({
            date: validParams.date,
            meal: validParams.meal,
            returnTo: validParams.returnTo,
            resumeStep: validParams.barcodeResume,
            barcode: validParams.barcode
        });

        expect(login.pathname).toBe('/(auth)/login');
        expect(resolveBarcodeAuthDestination(login.params)).toEqual({
            pathname: '/barcode',
            params: {
                date: '2026-08-09',
                meal: MEAL_PERIODS.DINNER,
                returnTo: BARCODE_RETURN_DESTINATIONS.FOOD_LOG,
                barcodeResume: BARCODE_RESUME_STEPS.LOOKUP,
                barcode: '012345678905'
            }
        });
    });

    it('returns manual food entry without putting its draft fields in the URL', () => {
        const login = createBarcodeLoginDestination({
            date: '2026-08-09',
            meal: MEAL_PERIODS.DINNER,
            returnTo: BARCODE_RETURN_DESTINATIONS.FOOD_LOG,
            resumeStep: BARCODE_RESUME_STEPS.MANUAL_FOOD
        });

        expect(resolveBarcodeAuthDestination(login.params)).toEqual({
            pathname: '/barcode',
            params: {
                date: '2026-08-09',
                meal: MEAL_PERIODS.DINNER,
                returnTo: BARCODE_RETURN_DESTINATIONS.FOOD_LOG,
                barcodeResume: BARCODE_RESUME_STEPS.MANUAL_FOOD
            }
        });
        expect(JSON.stringify(login.params)).not.toContain('Market snack');
    });

    it.each([
        { ...validParams, barcodeAuthReturn: '/settings' },
        { ...validParams, returnTo: 'https://malicious.example' },
        { ...validParams, date: '2026-02-31' },
        { ...validParams, meal: 'MIDNIGHT_FEAST' },
        { ...validParams, barcodeAuthReturn: ['barcode', '/settings'] },
        { ...validParams, barcode: undefined }
    ])('rejects malformed or non-allowlisted returns', (params) => {
        expect(resolveBarcodeAuthDestination(params as unknown as BarcodeAuthReturnParams)).toBeNull();
    });
});
