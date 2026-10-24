/** @file log: Turns a dated log deep link into a shared add-food request and returns to the food surface. */

import { useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import type { MealPeriod } from '@calibrate/shared';
import { LoadingState } from '../../../src/components/LoadingState';
import { useAddFoodRequest } from '../../../src/context/AddFoodRequestContext';
import { MEAL_OPTIONS } from '../../../src/utils/meals';

/** Turns a dated log deep link into a shared add-food request and returns to the food surface. */
export default function LogScreen() {
    const { date, meal } = useLocalSearchParams<{ date?: string; meal?: MealPeriod }>();
    const { requestAddFood } = useAddFoodRequest();

    useEffect(() => {
        const requestedMeal = typeof meal === 'string' && MEAL_OPTIONS.includes(meal as MealPeriod)
            ? meal as MealPeriod
            : undefined;
        requestAddFood({
            date: typeof date === 'string' ? date : undefined,
            meal: requestedMeal
        });
        router.replace({
            pathname: '/today',
            params: {
                openAddFood: 'true',
                date: typeof date === 'string' ? date : undefined,
                meal: requestedMeal
            }
        });
    }, [date, meal, requestAddFood]);

    return <LoadingState label="Opening add food..." />;
}
