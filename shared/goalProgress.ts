/** @file Signed goal direction, steady-rate projection, and weight-progress calculations. */

export type GoalProgressMode = 'lose' | 'gain' | 'maintain';

export type CanonicalGoal = {
    startWeightGrams: number;
    targetWeightGrams: number;
    dailyDeficit: number;
};

export type CanonicalGoalProgress = {
    mode: GoalProgressMode;
    progressPercent: number | null;
    progressWeightGrams: number | null;
    remainingWeightGrams: number;
    isComplete: boolean;
};

/** Derive the product's goal direction from the signed calorie target adjustment. */
export function getGoalProgressMode(dailyDeficit: number): GoalProgressMode {
    if (dailyDeficit > 0) return 'lose';
    if (dailyDeficit < 0) return 'gain';
    return 'maintain';
}

/**
 * Calculate bounded goal progress using canonical grams.
 *
 * Maintenance is intentionally ongoing and neutral: it has no completion percentage or
 * terminal state. Loss and gain use mirrored direction-aware calculations.
 */
export function calculateCanonicalGoalProgress(
    goal: CanonicalGoal,
    currentWeightGrams: number | null
): CanonicalGoalProgress {
    const mode = getGoalProgressMode(goal.dailyDeficit);
    const targetDistance = Math.abs(goal.targetWeightGrams - goal.startWeightGrams);

    if (currentWeightGrams === null) {
        return {
            mode,
            progressPercent: null,
            progressWeightGrams: null,
            remainingWeightGrams: targetDistance,
            isComplete: false
        };
    }

    if (mode === 'maintain') {
        return {
            mode,
            progressPercent: null,
            progressWeightGrams: null,
            remainingWeightGrams: Math.abs(currentWeightGrams - goal.targetWeightGrams),
            isComplete: false
        };
    }

    const hasCoherentDirection =
        mode === 'lose'
            ? goal.targetWeightGrams < goal.startWeightGrams
            : goal.targetWeightGrams > goal.startWeightGrams;
    if (!hasCoherentDirection || targetDistance === 0) {
        return {
            mode,
            progressPercent: null,
            progressWeightGrams: null,
            remainingWeightGrams: Math.abs(currentWeightGrams - goal.targetWeightGrams),
            isComplete: false
        };
    }

    const rawProgressWeightGrams =
        mode === 'lose'
            ? goal.startWeightGrams - currentWeightGrams
            : currentWeightGrams - goal.startWeightGrams;
    const remainingWeightGrams =
        mode === 'lose'
            ? Math.max(0, currentWeightGrams - goal.targetWeightGrams)
            : Math.max(0, goal.targetWeightGrams - currentWeightGrams);
    const isComplete =
        mode === 'lose'
            ? currentWeightGrams <= goal.targetWeightGrams
            : currentWeightGrams >= goal.targetWeightGrams;
    const boundedPercent = Math.max(0, Math.min(100, (rawProgressWeightGrams / targetDistance) * 100));

    return {
        mode,
        progressPercent: Math.round(boundedPercent * 10) / 10,
        progressWeightGrams: Math.max(0, rawProgressWeightGrams),
        remainingWeightGrams,
        isComplete
    };
}
