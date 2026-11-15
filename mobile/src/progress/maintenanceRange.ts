/** @file Defines editable maintenance distances and converts range drafts to canonical gram bounds. */

import type { MaintenanceRange, WeightUnit } from '@calibrate/shared';
import { gramsToDisplayWeight } from '../utils/bodyMeasurements';
import { formatWeightUnit } from '../utils/format';
import { parseWeightInput, weightInputToCanonicalGrams } from '../weightEntry/input';

export const MAINTENANCE_DISTANCE_LIMITS = {
    LB: { min: 1, max: 5, step: 0.5 },
    KG: { min: 0.5, max: 3, step: 0.25 }
} as const;

/** List the valid editable distances in ascending order for the selected unit. */
export function maintenanceDistanceSteps(unit: WeightUnit): number[] {
    const { min, max, step } = MAINTENANCE_DISTANCE_LIMITS[unit];
    return Array.from({ length: (max - min) / step + 1 }, (_, index) => min + index * step);
}

/** Explain how to correct a typed distance outside the stepper's choices. */
export function maintenanceDistanceError(unit: WeightUnit): string {
    const { min, max, step } = MAINTENANCE_DISTANCE_LIMITS[unit];
    const label = formatWeightUnit(unit);
    return `Enter a range distance from ${min} to ${max} ${label} in steps of ${step} ${label}.`;
}

/** Keep saved offsets exact when recentering, including ranges with unequal sides. */
export function recenterMaintenanceRange(range: MaintenanceRange, target: number): MaintenanceRange {
    const shift = target - range.target_weight_grams;
    return { target_weight_grams: target, lower_weight_grams: range.lower_weight_grams + shift, upper_weight_grams: range.upper_weight_grams + shift };
}

/** Convert a supported step once for both bounds. Zero marks an incomplete or unsupported entry. */
export function distanceFromInput(value: string, unit: WeightUnit): number {
    const parsed = parseWeightInput(value);
    return parsed !== null && maintenanceDistanceSteps(unit).includes(parsed) ? weightInputToCanonicalGrams(parsed, unit) : 0;
}

/** Build a centered draft. The caller validates the target and both resulting bounds before submission. */
export function centeredMaintenanceRange(target: number, distance: number): MaintenanceRange {
    return { target_weight_grams: target, lower_weight_grams: target - distance, upper_weight_grams: target + distance };
}

/** Show quarter-kilogram steps and converted distances without changing their stored gram values. */
export function displayMaintenanceDistance(distance: number, unit: WeightUnit): string {
    return gramsToDisplayWeight(distance, unit, 2).replace(/\.?0+$/, '');
}

/** Round up when symmetrizing existing bounds, clamping to the supported choices. */
export function suggestSymmetricDistance(distance: number, unit: WeightUnit): string {
    const existingDistance = Number(displayMaintenanceDistance(distance, unit));
    const steps = maintenanceDistanceSteps(unit);
    return String(steps.find(step => step >= existingDistance) ?? MAINTENANCE_DISTANCE_LIMITS[unit].max);
}
