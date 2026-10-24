/** @file draft: Validates reviewed OCR food fields and returns the first actionable error or null. */

import type { CreateMyFoodPayload } from '@calibrate/api-client';

export type LabelFoodFields = { title: string; quantity: string; unit: string; calories: string };

/** Validates reviewed OCR food fields and returns the first actionable error or null. */
export function validateLabelFood(fields: LabelFoodFields): string | null {
    if (!fields.title.trim()) return 'Enter a title for this saved food.';
    if (fields.title.trim().length > 120) return 'Use a title of 120 characters or fewer.';
    if (!fields.quantity.trim() || !Number.isFinite(Number(fields.quantity)) || Number(fields.quantity) <= 0) {
        return 'Enter a serving quantity greater than zero.';
    }
    if (!fields.unit.trim() || fields.unit.trim().length > 48) return 'Enter a serving unit of 48 characters or fewer.';
    if (!fields.calories.trim() || !Number.isFinite(Number(fields.calories)) || Number(fields.calories) < 0) {
        return 'Enter zero or more calories per serving.';
    }
    return null;
}

/** Validates and normalizes reviewed OCR fields into a saved-food request, throwing on invalid input. */
export function labelFoodPayload(fields: LabelFoodFields): CreateMyFoodPayload {
    const error = validateLabelFood(fields);
    if (error) throw new Error(error);
    return {
        name: fields.title.trim(),
        serving_size_quantity: Number(fields.quantity),
        serving_unit_label: fields.unit.trim(),
        calories_per_serving: Number(fields.calories)
    };
}
