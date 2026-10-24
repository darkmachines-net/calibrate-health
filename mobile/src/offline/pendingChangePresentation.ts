/** @file pending Change Presentation: Present durable intent without inventing server IDs, calculated totals, or successful synchronization. */

import type { QueuedMutation } from './queuedMutation';
import { OFFLINE_MUTATION_OPERATIONS as OP } from './operations';

type Fields = Record<string, unknown>;
const record = (value: unknown): Fields => value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};

/** Present durable intent without inventing server IDs, calculated totals, or successful synchronization. */
export function describePendingChange(mutation: Pick<QueuedMutation, 'operation' | 'payload'>, weightUnit: string): { title: string; details: string[] } {
    const payload = record(mutation.payload);
    const details: string[] = [];
    const add = (label: string, value: unknown, suffix = '') => {
        if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) details.push(label + ': ' + value + suffix);
    };
    add('Date', payload.date);
    switch (mutation.operation) {
        case OP.ADD_METRIC:
            add('Weight', payload.weight, ' ' + weightUnit);
            return { title: 'Weigh-in saved locally', details };
        case OP.DELETE_METRIC:
            add('Entry', payload.id);
            return { title: 'Weigh-in deletion pending', details };
        case OP.CREATE_FOOD_LOG:
        case OP.UPDATE_FOOD_LOG: {
            const food = mutation.operation === OP.CREATE_FOOD_LOG ? payload : record(payload.update);
            add('Food', food.name);
            if (!food.name) add('Saved food', food.my_food_id);
            add('Entry', payload.id);
            add('Meal', food.meal_period);
            add('Calories', food.calories, ' kcal');
            add('Servings', food.servings_consumed);
            add('Measure', food.measure_label);
            add('Quantity', food.measure_quantity_snapshot);
            return { title: mutation.operation === OP.CREATE_FOOD_LOG ? 'Food saved locally' : 'Food edit pending', details };
        }
        case OP.DELETE_FOOD_LOG:
            add('Entry', payload.id);
            return { title: 'Food deletion pending', details };
        case OP.UPDATE_FOOD_DAY:
            add('Day status', payload.is_complete ? 'COMPLETE' : 'OPEN');
            return { title: 'Tracking day change pending', details };
        case OP.SET_FOOD_DAY_STATUS:
            add('Day status', payload.status);
            return { title: 'Tracking day change pending', details };
        default:
            add('Starts', payload.starts_on);
            add('Expected resume', payload.expected_resume_on);
            add('Resume date', payload.resumed_on);
            return { title: 'Tracking pause change pending', details };
    }
}
