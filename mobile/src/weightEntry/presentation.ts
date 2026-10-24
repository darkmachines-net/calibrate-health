/** @file presentation: Select one clear recognition headline even when the server reports several crossed thresholds. */

import type {
    MetricProgressRecognition,
    MetricProgressUpdate,
    MetricSaveKind
} from '@calibrate/api-client';
import type { WeightUnit } from '@calibrate/shared';
import { formatWeightUnit } from '../utils/format';

const GRAMS_PER_KILOGRAM = 1000;
const GRAMS_PER_POUND = 453.59237;

export type WeightRecognitionPresentation = {
    title: string;
    message: string;
    icon: 'checkmark-circle' | 'flag' | 'ribbon' | 'trending-down' | 'trending-up' | 'sparkles';
    goalReached: boolean;
};

function formatGrams(grams: number, unit: WeightUnit | undefined): string {
    const value = unit === 'LB' ? grams / GRAMS_PER_POUND : grams / GRAMS_PER_KILOGRAM;
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${formatWeightUnit(unit)}`;
}

function findRecognition<T extends MetricProgressRecognition['type']>(
    recognitions: MetricProgressRecognition[],
    type: T
): Extract<MetricProgressRecognition, { type: T }> | undefined {
    return recognitions.find(
        (recognition): recognition is Extract<MetricProgressRecognition, { type: T }> => recognition.type === type
    );
}

function getDefaultPresentation(saveKind: MetricSaveKind | undefined): WeightRecognitionPresentation {
    if (saveKind === 'updated') {
        return {
            title: 'Weight updated',
            message: 'Your trend and goal progress now reflect this change.',
            icon: 'checkmark-circle',
            goalReached: false
        };
    }
    if (saveKind === 'unchanged') {
        return {
            title: 'Already up to date',
            message: 'This weigh-in already matches the saved value.',
            icon: 'checkmark-circle',
            goalReached: false
        };
    }
    return {
        title: 'Weight logged',
        message: 'Daily changes can be noisy. Your trend shows the bigger picture.',
        icon: 'checkmark-circle',
        goalReached: false
    };
}

/** Select one clear recognition headline even when the server reports several crossed thresholds. */
export function getWeightRecognitionPresentation(
    progressUpdate: MetricProgressUpdate | undefined,
    unit: WeightUnit | undefined
): WeightRecognitionPresentation {
    if (!progressUpdate) return getDefaultPresentation(undefined);
    if (!progressUpdate.is_current_day) {
        return {
            title: progressUpdate.save_kind === 'updated' ? 'History updated' : 'Added to your history',
            message: 'Your weight trend has been recalculated with this past weigh-in.',
            icon: 'checkmark-circle',
            goalReached: false
        };
    }

    const recognitions = progressUpdate.recognitions;
    if (findRecognition(recognitions, 'goal_reached')) {
        return {
            title: 'Goal reached!',
            message: 'You reached the target you set. Take a moment to celebrate your progress.',
            icon: 'flag',
            goalReached: true
        };
    }

    const percentMilestone = recognitions
        .filter((recognition): recognition is Extract<MetricProgressRecognition, { type: 'goal_percent' }> => (
            recognition.type === 'goal_percent'
        ))
        .sort((a, b) => b.threshold_percent - a.threshold_percent)[0];
    if (percentMilestone) {
        let title = `${percentMilestone.threshold_percent}% toward your goal`;
        if (percentMilestone.threshold_percent === 50) title = 'Halfway to your goal';
        if (percentMilestone.threshold_percent === 75) title = 'Three quarters of the way there';
        return {
            title,
            message: 'Your consistent check-ins are showing meaningful progress.',
            icon: 'ribbon',
            goalReached: false
        };
    }

    const weightMilestone = recognitions
        .filter((recognition): recognition is Extract<MetricProgressRecognition, { type: 'goal_weight' }> => (
            recognition.type === 'goal_weight'
        ))
        .sort((a, b) => b.threshold_grams - a.threshold_grams)[0];
    if (weightMilestone) {
        return {
            title: `${formatGrams(weightMilestone.threshold_grams, unit)} of progress`,
            message: 'You crossed another meaningful milestone toward your goal.',
            icon: 'ribbon',
            goalReached: false
        };
    }

    if (findRecognition(recognitions, 'meaningful_best')) {
        const goalMode = progressUpdate.goal?.mode;
        return {
            title: goalMode === 'gain' ? 'A new high for this goal' : 'A new low for this goal',
            message: 'This weigh-in marks meaningful progress in the direction you chose.',
            icon: goalMode === 'gain' ? 'trending-up' : 'trending-down',
            goalReached: false
        };
    }

    if (findRecognition(recognitions, 'baseline_recorded')) {
        return {
            title: 'Your trend starts here',
            message: 'Log another weigh-in when you are ready to reveal the bigger picture.',
            icon: 'sparkles',
            goalReached: false
        };
    }

    return getDefaultPresentation(progressUpdate.save_kind);
}

/** Formats remaining goal grams in display units after clamping negative remainder to zero. */
export function formatRemainingGoalWeight(grams: number, unit: WeightUnit | undefined): string {
    return formatGrams(Math.max(0, grams), unit);
}
