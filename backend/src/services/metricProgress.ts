/** @file metric Progress: Build the authoritative post-save progress receipt from before/after metric history. The caller runs this inside the idempotent mutation transaction so a replay receives exactly the same milestone facts as the original save. */

import {
    calculateCanonicalGoalProgress,
    type CanonicalGoal,
    type GoalProgressMode
} from '../../../shared/goalProgress';

const GOAL_PERCENT_THRESHOLDS = [25, 50, 75] as const;
const GRAMS_PER_POUND = 453.59237;
const MEANINGFUL_CHANGE_GRAMS = {
    KG: 500,
    LB: Math.round(GRAMS_PER_POUND)
} as const;
const GOAL_WEIGHT_INCREMENT_GRAMS = {
    KG: 2000,
    LB: Math.round(5 * GRAMS_PER_POUND)
} as const;
const CANONICAL_ROUNDING_TOLERANCE_GRAMS = 1;

export type MetricSaveKind = 'created' | 'updated' | 'unchanged';

type MetricProgressRecognition =
    | { type: 'goal_reached' }
    | { type: 'goal_percent'; threshold_percent: (typeof GOAL_PERCENT_THRESHOLDS)[number] }
    | { type: 'goal_weight'; threshold_grams: number }
    | { type: 'meaningful_best'; improvement_grams: number }
    | { type: 'baseline_recorded' };

export type MetricProgressGoal = {
    id: number;
    startWeightGrams: number;
    targetWeightGrams: number;
    dailyDeficit: number;
    createdLocalDate: string;
};

export type MetricProgressHistoryEntry = {
    localDate: string;
    weightGrams: number;
};

export type MetricProgressUpdate = {
    save_kind: MetricSaveKind;
    local_date: string;
    is_current_day: boolean;
    current_weight_grams: number;
    goal: null | {
        id: number;
        mode: GoalProgressMode;
        previous_progress_percent: number | null;
        current_progress_percent: number | null;
        remaining_weight_grams: number;
        is_complete: boolean;
        reached_local_date: string | null;
    };
    recognitions: MetricProgressRecognition[];
};

type EvaluateMetricProgressOptions = {
    saveKind: MetricSaveKind;
    savedLocalDate: string;
    currentLocalDate: string;
    currentWeightGrams: number;
    weightUnit: 'KG' | 'LB';
    goal: MetricProgressGoal | null;
    previousMetrics: MetricProgressHistoryEntry[];
    hadAnyMetricBeforeSave: boolean;
};

function toCanonicalGoal(goal: MetricProgressGoal): CanonicalGoal {
    return {
        startWeightGrams: goal.startWeightGrams,
        targetWeightGrams: goal.targetWeightGrams,
        dailyDeficit: goal.dailyDeficit
    };
}

function getHighestProgressPercent(goal: CanonicalGoal, metrics: MetricProgressHistoryEntry[]): number | null {
    let best: number | null = null;
    for (const metric of metrics) {
        const progress = calculateCanonicalGoalProgress(goal, metric.weightGrams).progressPercent;
        if (progress !== null && (best === null || progress > best)) {
            best = progress;
        }
    }
    return best;
}

function getHighestProgressWeightGrams(goal: CanonicalGoal, metrics: MetricProgressHistoryEntry[]): number {
    return metrics.reduce((best, metric) => {
        const progress = calculateCanonicalGoalProgress(goal, metric.weightGrams).progressWeightGrams;
        return progress === null ? best : Math.max(best, progress);
    }, 0);
}

function findReachedLocalDate(goal: CanonicalGoal, metrics: MetricProgressHistoryEntry[]): string | null {
    const reached = metrics
        .filter((metric) => calculateCanonicalGoalProgress(goal, metric.weightGrams).isComplete)
        .sort((left, right) => left.localDate.localeCompare(right.localDate));
    return reached[0]?.localDate ?? null;
}

function getLatestMetric(metrics: MetricProgressHistoryEntry[]): MetricProgressHistoryEntry | null {
    return metrics.reduce<MetricProgressHistoryEntry | null>((latest, metric) => {
        if (!latest) return metric;
        return metric.localDate > latest.localDate ? metric : latest;
    }, null);
}

function getMeaningfulBestRecognition(
    goal: CanonicalGoal,
    mode: GoalProgressMode,
    previousMetrics: MetricProgressHistoryEntry[],
    currentWeightGrams: number,
    weightUnit: 'KG' | 'LB'
): MetricProgressRecognition | null {
    if (mode === 'maintain') return null;

    const previousWeights = [goal.startWeightGrams, ...previousMetrics.map((metric) => metric.weightGrams)];
    const previousBest =
        mode === 'lose' ? Math.min(...previousWeights) : Math.max(...previousWeights);
    const improvementGrams =
        mode === 'lose' ? previousBest - currentWeightGrams : currentWeightGrams - previousBest;

    if (improvementGrams + CANONICAL_ROUNDING_TOLERANCE_GRAMS < MEANINGFUL_CHANGE_GRAMS[weightUnit]) {
        return null;
    }
    return { type: 'meaningful_best', improvement_grams: improvementGrams };
}

/**
 * Build the authoritative post-save progress receipt from before/after metric history.
 * The caller runs this inside the idempotent mutation transaction so a replay receives
 * exactly the same milestone facts as the original save.
 */
export function evaluateMetricProgressUpdate(options: EvaluateMetricProgressOptions): MetricProgressUpdate {
    const isCurrentDay = options.savedLocalDate === options.currentLocalDate;
    const canRecognize = isCurrentDay && options.saveKind !== 'unchanged';
    const baseUpdate = {
        save_kind: options.saveKind,
        local_date: options.savedLocalDate,
        is_current_day: isCurrentDay,
        current_weight_grams: options.currentWeightGrams
    } as const;

    if (!options.goal) {
        return {
            ...baseUpdate,
            goal: null,
            recognitions:
                canRecognize && !options.hadAnyMetricBeforeSave ? [{ type: 'baseline_recorded' }] : []
        };
    }

    const goal = toCanonicalGoal(options.goal);
    const previousGoalMetrics = options.previousMetrics.filter(
        (metric) =>
            metric.localDate >= options.goal!.createdLocalDate && metric.localDate <= options.currentLocalDate
    );
    const previousReachedLocalDate = findReachedLocalDate(goal, previousGoalMetrics);
    const previousProgressPercent =
        previousReachedLocalDate === null ? getHighestProgressPercent(goal, previousGoalMetrics) : 100;
    const savedProgress = calculateCanonicalGoalProgress(goal, options.currentWeightGrams);

    // Replace a same-day value rather than retaining both versions when evaluating durable completion.
    const retainedMetrics = previousGoalMetrics.filter((metric) => metric.localDate !== options.savedLocalDate);
    if (options.savedLocalDate >= options.goal.createdLocalDate && options.savedLocalDate <= options.currentLocalDate) {
        retainedMetrics.push({
            localDate: options.savedLocalDate,
            weightGrams: options.currentWeightGrams
        });
    }
    const reachedLocalDate = findReachedLocalDate(goal, retainedMetrics);
    const isComplete = reachedLocalDate !== null;
    const latestMetric = getLatestMetric(retainedMetrics);
    const currentProgress = calculateCanonicalGoalProgress(
        goal,
        latestMetric?.weightGrams ?? goal.startWeightGrams
    );

    let recognition: MetricProgressRecognition | null = null;
    if (canRecognize && savedProgress.mode !== 'maintain') {
        if (savedProgress.isComplete && previousReachedLocalDate === null) {
            recognition = { type: 'goal_reached' };
        } else {
            const previousBestPercent = previousProgressPercent ?? 0;
            const crossedPercentThresholds = GOAL_PERCENT_THRESHOLDS.filter(
                (threshold) =>
                    savedProgress.progressPercent !== null &&
                    savedProgress.progressPercent >= threshold &&
                    previousBestPercent < threshold
            );
            const crossedPercentThreshold = crossedPercentThresholds[crossedPercentThresholds.length - 1];
            if (crossedPercentThreshold !== undefined) {
                recognition = { type: 'goal_percent', threshold_percent: crossedPercentThreshold };
            } else {
                const incrementGrams = GOAL_WEIGHT_INCREMENT_GRAMS[options.weightUnit];
                const previousProgressGrams = getHighestProgressWeightGrams(goal, previousGoalMetrics);
                const currentProgressGrams = savedProgress.progressWeightGrams ?? 0;
                const previousIncrement = Math.floor(
                    (previousProgressGrams + CANONICAL_ROUNDING_TOLERANCE_GRAMS) / incrementGrams
                );
                const currentIncrement = Math.floor(
                    (currentProgressGrams + CANONICAL_ROUNDING_TOLERANCE_GRAMS) / incrementGrams
                );
                if (currentIncrement > previousIncrement && currentIncrement > 0) {
                    recognition = {
                        type: 'goal_weight',
                        threshold_grams: currentIncrement * incrementGrams
                    };
                } else {
                    recognition = getMeaningfulBestRecognition(
                        goal,
                        savedProgress.mode,
                        previousGoalMetrics,
                        options.currentWeightGrams,
                        options.weightUnit
                    );
                }
            }
        }
    }

    if (recognition === null && canRecognize && !options.hadAnyMetricBeforeSave) {
        recognition = { type: 'baseline_recorded' };
    }

    return {
        ...baseUpdate,
        goal: {
            id: options.goal.id,
            mode: currentProgress.mode,
            previous_progress_percent: previousProgressPercent,
            current_progress_percent: isComplete ? 100 : currentProgress.progressPercent,
            remaining_weight_grams: isComplete ? 0 : currentProgress.remainingWeightGrams,
            is_complete: isComplete,
            reached_local_date: reachedLocalDate
        },
        recognitions: recognition === null ? [] : [recognition]
    };
}
