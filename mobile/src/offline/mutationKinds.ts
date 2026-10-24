/** @file Allowlisted offline mutation operations used by queue persistence and replay dispatch. */

export const OFFLINE_MUTATION_OPERATIONS = {
    CREATE_FOOD_LOG: 'food.create',
    UPDATE_FOOD_LOG: 'food.update',
    DELETE_FOOD_LOG: 'food.delete',
    ADD_METRIC: 'metric.add',
    DELETE_METRIC: 'metric.delete',
    UPDATE_FOOD_DAY: 'food-day.update',
    SET_FOOD_DAY_STATUS: 'food-day.set-status',
    START_FOOD_TRACKING_PAUSE: 'food-tracking-pause.start',
    UPDATE_FOOD_TRACKING_PAUSE: 'food-tracking-pause.update',
    RESUME_FOOD_TRACKING: 'food-tracking-pause.resume'
} as const;

export type OfflineMutationOperation =
    typeof OFFLINE_MUTATION_OPERATIONS[keyof typeof OFFLINE_MUTATION_OPERATIONS];
