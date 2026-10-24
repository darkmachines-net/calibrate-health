/** @file food Preview: Include every meal period so an empty slot stays distinct from food logged with zero calories. */

import type { FoodLogEntry } from '@calibrate/api-client';
import { MEAL_PERIODS, type MealPeriod } from '@calibrate/shared';

type TodayFoodMeal = {
    meal: MealPeriod;
    entryCount: number;
    calories: number;
};

/** Include every meal period so an empty slot stays distinct from food logged with zero calories. */
export function getTodayFoodMeals(entries: readonly FoodLogEntry[]): TodayFoodMeal[] {
    return Object.values(MEAL_PERIODS).map((meal) => {
        const mealEntries = entries.filter((entry) => entry.meal_period === meal);
        return {
            meal,
            entryCount: mealEntries.length,
            calories: mealEntries.reduce((total, entry) => total + entry.calories, 0)
        };
    });
}
