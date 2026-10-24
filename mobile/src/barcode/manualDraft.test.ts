/** @file Regression coverage for manual Draft: barcode manual food draft. */

import { MEAL_PERIODS } from '@calibrate/shared';
import { BARCODE_RETURN_DESTINATIONS } from './context';
import {
    clearBarcodeManualFoodDraft,
    readBarcodeManualFoodDraft,
    saveBarcodeManualFoodDraft
} from './manualDraft';

describe('barcode manual food draft', () => {
    afterEach(clearBarcodeManualFoodDraft);

    it('restores only the matching in-memory authentication return context', () => {
        saveBarcodeManualFoodDraft({
            ownerId: 42,
            date: '2026-08-09',
            meal: MEAL_PERIODS.DINNER,
            returnTo: BARCODE_RETURN_DESTINATIONS.FOOD_LOG,
            name: 'Market snack',
            calories: '245'
        });

        expect(readBarcodeManualFoodDraft({
            ownerId: 42,
            date: '2026-08-09',
            meal: MEAL_PERIODS.DINNER,
            returnTo: BARCODE_RETURN_DESTINATIONS.FOOD_LOG
        })).toEqual({ name: 'Market snack', calories: '245' });
        expect(readBarcodeManualFoodDraft({
            ownerId: 42,
            date: '2026-08-09',
            meal: MEAL_PERIODS.LUNCH,
            returnTo: BARCODE_RETURN_DESTINATIONS.FOOD_LOG
        })).toBeNull();
        expect(readBarcodeManualFoodDraft({
            ownerId: 43,
            date: '2026-08-09',
            meal: MEAL_PERIODS.DINNER,
            returnTo: BARCODE_RETURN_DESTINATIONS.FOOD_LOG
        })).toBeNull();
    });

    it('clears a draft after completion or cancellation', () => {
        saveBarcodeManualFoodDraft({
            ownerId: 42,
            date: '2026-08-09',
            meal: MEAL_PERIODS.DINNER,
            returnTo: BARCODE_RETURN_DESTINATIONS.TODAY,
            name: '',
            calories: '100'
        });
        clearBarcodeManualFoodDraft();

        expect(readBarcodeManualFoodDraft({
            ownerId: 42,
            date: '2026-08-09',
            meal: MEAL_PERIODS.DINNER,
            returnTo: BARCODE_RETURN_DESTINATIONS.TODAY
        })).toBeNull();
    });
});
