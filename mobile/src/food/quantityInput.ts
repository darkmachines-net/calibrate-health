/** @file quantity Input: Pick a practical button increment while keeping precise keyboard entry available. */

import { SERVING_INPUT_INCREMENT } from '../config/inputPrecision';

export const MINIMUM_FOOD_QUANTITY = 0.001;

const WHOLE_UNIT_LABELS = new Set([
    'g', 'gram', 'grams',
    'mg', 'milligram', 'milligrams',
    'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'
]);
const HUNDREDTH_UNIT_LABELS = new Set([
    'kg', 'kilogram', 'kilograms',
    'l', 'liter', 'liters', 'litre', 'litres'
]);
const QUARTER_UNIT_LABELS = new Set([
    'oz', 'ounce', 'ounces',
    'fl oz', 'fluid ounce', 'fluid ounces',
    'lb', 'lbs', 'pound', 'pounds',
    'cup', 'cups',
    'tbsp', 'tablespoon', 'tablespoons',
    'tsp', 'teaspoon', 'teaspoons',
    'serving', 'servings'
]);
const HALF_UNIT_LABELS = new Set([
    'bar', 'bars',
    'bottle', 'bottles',
    'can', 'cans',
    'container', 'containers',
    'cookie', 'cookies',
    'cracker', 'crackers',
    'egg', 'eggs',
    'item', 'items',
    'package', 'packages',
    'packet', 'packets',
    'piece', 'pieces',
    'scoop', 'scoops',
    'slice', 'slices'
]);

/** Pick a practical button increment while keeping precise keyboard entry available. */
export function getFoodQuantityStep(unitLabel: string): number {
    const normalizedUnit = unitLabel.trim().replace(/\s+/g, ' ').toLowerCase();
    if (WHOLE_UNIT_LABELS.has(normalizedUnit)) return 1;
    if (HUNDREDTH_UNIT_LABELS.has(normalizedUnit)) return 0.01;
    if (QUARTER_UNIT_LABELS.has(normalizedUnit)) return 0.25;
    if (HALF_UNIT_LABELS.has(normalizedUnit)) return 0.5;
    return SERVING_INPUT_INCREMENT;
}
