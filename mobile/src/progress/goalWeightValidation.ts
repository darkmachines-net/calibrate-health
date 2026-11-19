/** @file Shared weight validation for onboarding, goal setup, and maintenance reviews. */

import { assessMaintenanceRange, isMaintenanceRange, isPolicyWeight, type MaintenanceRange, type WeightUnit } from '@calibrate/shared';
import { gramsToDisplayWeight } from '../utils/bodyMeasurements';
import { formatWeightUnit } from '../utils/format';
import type { GoalMode } from '../utils/goals';
import { getWeightPolicyError } from '../weightEntry/input';
import { maintenanceDistanceError } from './maintenanceRange';

/** Validate a target against the starting weight and any proposed maintenance bounds. */
export function getGoalWeightIssue({ mode, starting, target, targetEntered, unit, range, invalidDistance, requireStartingWeight = true }: {
    mode: GoalMode;
    starting: number | null;
    target: number | null;
    targetEntered: boolean;
    unit: WeightUnit;
    range?: MaintenanceRange | null;
    invalidDistance?: boolean;
    requireStartingWeight?: boolean;
}): { message: string; target?: boolean; range?: boolean } | undefined {
    if (requireStartingWeight && !isPolicyWeight(starting)) return { message: 'Log your current weight before setting a goal.' };
    if (!isPolicyWeight(target)) {
        return { target: true, message: targetEntered ? getWeightPolicyError(unit) : 'Enter a target weight.' };
    }
    if (range && invalidDistance) return { range: true, message: maintenanceDistanceError(unit) };
    if (range && !isMaintenanceRange(target, range.lower_weight_grams, range.upper_weight_grams)) {
        return { target: true, range: true, message: 'Adjust the target or range so both limits are within the supported weight range.' };
    }
    if (!isPolicyWeight(starting)) return;
    const currentWeight = `${gramsToDisplayWeight(starting, unit)} ${formatWeightUnit(unit)}`;
    if (range && requireStartingWeight && assessMaintenanceRange(starting, range) !== 'within_range') {
        return { target: true, range: true, message: `Adjust the target or range to include your current weight of ${currentWeight}.` };
    }
    if (mode === 'lose' && target >= starting) return { target: true, message: `Enter a target below your current weight of ${currentWeight}.` };
    if (mode === 'gain' && target <= starting) return { target: true, message: `Enter a target above your current weight of ${currentWeight}.` };
}
