/** @file presentation: Maps calorie-policy reasons to actionable presentation, retaining a safe default for unknown reasons. */

import type { CaloriePlanReasonCode, CaloriePlanStatus } from '@calibrate/shared';

export type CaloriePlanPresentation = {
    title: string;
    message: string;
    actionLabel: string;
    actionKind: 'profile' | 'weight' | 'goal';
};

const DEFAULT_PRESENTATION: CaloriePlanPresentation = {
    title: 'Calorie plan unavailable',
    message: 'Calorie planning is unavailable until the server can verify your profile and goal.',
    actionLabel: 'Review calorie plan',
    actionKind: 'goal'
};

const PRESENTATIONS: Record<CaloriePlanReasonCode, CaloriePlanPresentation> = {
    DATE_OF_BIRTH_REQUIRED: {
        title: 'Date of birth required',
        message: 'Add your exact date of birth for your calorie estimate.',
        actionLabel: 'Review profile',
        actionKind: 'profile'
    },
    DATE_OF_BIRTH_INVALID: {
        title: 'Review your date of birth',
        message: 'Enter a valid date of birth in YYYY-MM-DD format.',
        actionLabel: 'Review profile',
        actionKind: 'profile'
    },
    DATE_OF_BIRTH_IN_FUTURE: {
        title: 'Review your date of birth',
        message: 'Your date of birth cannot be in the future.',
        actionLabel: 'Review profile',
        actionKind: 'profile'
    },
    AGE_OVER_120: {
        title: 'Review your date of birth',
        message: 'Enter a valid date of birth with an age no greater than 120.',
        actionLabel: 'Review profile',
        actionKind: 'profile'
    },
    TIMEZONE_INVALID: {
        title: 'Review your time zone',
        message: 'Choose a valid time zone so Calibrate can verify your local date.',
        actionLabel: 'Review profile',
        actionKind: 'profile'
    },
    SEX_REQUIRED: {
        title: 'Profile details required',
        message: 'Add the sex used by the calorie estimate.',
        actionLabel: 'Review profile',
        actionKind: 'profile'
    },
    ACTIVITY_LEVEL_REQUIRED: {
        title: 'Activity level required',
        message: 'Choose an activity level for your profile estimate.',
        actionLabel: 'Review profile',
        actionKind: 'profile'
    },
    HEIGHT_REQUIRED: {
        title: 'Height required',
        message: 'Add your height for your profile estimate.',
        actionLabel: 'Review profile',
        actionKind: 'profile'
    },
    HEIGHT_OUT_OF_RANGE: {
        title: 'Review your height',
        message: 'Enter a height within the supported range for your selected units.',
        actionLabel: 'Review profile',
        actionKind: 'profile'
    },
    LATEST_WEIGHT_REQUIRED: {
        title: 'Current weight required',
        message: 'Log a current weight before choosing a calorie plan.',
        actionLabel: 'Log weight',
        actionKind: 'weight'
    },
    WEIGHT_OUT_OF_RANGE: {
        title: 'Review your weight',
        message: 'Enter a weight within the supported range for your selected units.',
        actionLabel: 'Log weight',
        actionKind: 'weight'
    },
    GOAL_REQUIRED: {
        title: 'Goal required',
        message: 'Set a weight goal before using a calorie target.',
        actionLabel: 'Set goal',
        actionKind: 'goal'
    },
    GOAL_WEIGHTS_OUT_OF_RANGE: {
        title: 'Review goal weights',
        message: 'Goal weights must stay within the supported weight range.',
        actionLabel: 'Review calorie plan',
        actionKind: 'goal'
    },
    GOAL_DIRECTION_INVALID: {
        title: 'Review goal direction',
        message: 'Your target weight and calorie change must point in the same direction.',
        actionLabel: 'Review calorie plan',
        actionKind: 'goal'
    },
    DAILY_DEFICIT_INVALID: {
        title: 'Review calorie change',
        message: 'Choose one of the available calorie-change options.',
        actionLabel: 'Review calorie plan',
        actionKind: 'goal'
    },
    TARGET_BELOW_MINIMUM: {
        title: 'Option unavailable',
        message: 'This choice would put the daily target below the server-calculated safety minimum.',
        actionLabel: 'Choose another option',
        actionKind: 'goal'
    },
    PLAN_REVISION_UNSAFE: {
        title: 'Review calorie plan',
        message: 'A calorie-plan adjustment is no longer safe for the current profile.',
        actionLabel: 'Review calorie plan',
        actionKind: 'goal'
    },
    HISTORICAL_PLAN_REQUIRES_REVIEW: {
        title: 'Review calorie plan',
        message: 'Your existing plan is preserved, but it must be replaced before targets resume.',
        actionLabel: 'Review calorie plan',
        actionKind: 'goal'
    },
    SERVER_POLICY_UNAVAILABLE: DEFAULT_PRESENTATION
};

/** Maps calorie-policy reasons to actionable presentation, retaining a safe default for unknown reasons. */
export function getCaloriePlanPresentation(
    reasonCode: CaloriePlanReasonCode | null | undefined,
    status?: CaloriePlanStatus | 'unknown'
): CaloriePlanPresentation {
    if (reasonCode && PRESENTATIONS[reasonCode]) return PRESENTATIONS[reasonCode];
    if (status === 'requires_review') {
        return {
            title: 'Review calorie plan',
            message: 'Your logged history is preserved, but calorie targets and projections are paused.',
            actionLabel: 'Review calorie plan',
            actionKind: 'goal'
        };
    }
    return DEFAULT_PRESENTATION;
}

/** Returns the unavailable-plan explanation associated with the policy reason. */
export function getPlanOptionUnavailableCopy(reasonCode: CaloriePlanReasonCode | null | undefined): string {
    return getCaloriePlanPresentation(reasonCode).message;
}
