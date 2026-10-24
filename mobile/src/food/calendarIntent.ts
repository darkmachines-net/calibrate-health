/** @file calendar Intent: Fold acknowledged receipts before pending intent, including dates absent from the range. */

import type { FoodLogDay } from '@calibrate/api-client';
import { queuedFoodDayStatus } from '../offline/foodDayIntent';
import type { QueuedMutation } from '../offline/queuedMutation';

/** Fold acknowledged receipts before pending intent, including dates absent from the range. */
export function calendarDayWithIntent(date: string, day: FoodLogDay | undefined, intent: readonly QueuedMutation[]): FoodLogDay | undefined {
    const status = queuedFoodDayStatus(intent, date, day?.status);
    if (!status || status === day?.status) return day;
    return {
        date, status, origin: 'USER', source: 'STORED',
        is_representative: status === 'COMPLETE', is_complete: status === 'COMPLETE',
        completed_at: null, updated_at: null,
        calorie_comparison: status === 'PAUSED' || day?.status === 'PAUSED' ? undefined : day?.calorie_comparison
    };
}
