/** @file Regression coverage for food Preview: Today meal summaries. */

import type { FoodLogEntry } from '@calibrate/api-client';
import { getTodayFoodMeals } from './foodPreview';

describe('Today meal summaries', () => {
    it('keeps every meal period in chronological order and totals all entries without mutating them', () => {
        const entries: FoodLogEntry[] = [
            { id: 1, meal_period: 'DINNER', name: 'Salmon', calories: 300.25 },
            { id: 2, meal_period: 'BREAKFAST', name: 'Oatmeal', calories: 200 },
            { id: 3, meal_period: 'DINNER', name: 'Potatoes', calories: 210.25 },
            { id: 4, meal_period: 'AFTERNOON_SNACK', name: 'Tea', calories: 0 }
        ];
        expect(getTodayFoodMeals(entries)).toEqual([
            { meal: 'BREAKFAST', entryCount: 1, calories: 200 },
            { meal: 'MORNING_SNACK', entryCount: 0, calories: 0 },
            { meal: 'LUNCH', entryCount: 0, calories: 0 },
            { meal: 'AFTERNOON_SNACK', entryCount: 1, calories: 0 },
            { meal: 'DINNER', entryCount: 2, calories: 510.5 },
            { meal: 'EVENING_SNACK', entryCount: 0, calories: 0 }
        ]);
        expect(entries.map(({ id }) => id)).toEqual([1, 2, 3, 4]);
    });
});
