/** @file plan Check Presentation: Maps assessed pace to user-facing copy without changing the configured goal. */

import type React from 'react';
import type { Ionicons } from '@expo/vector-icons';
import type { CalibrationAssessmentBlocker, CalibrationPaceStatus } from '@calibrate/shared/calibration';

/** Maps assessed pace to user-facing copy without changing the configured goal. */
export function paceTitle(status: CalibrationPaceStatus): string {
    switch (status) {
        case 'aligned':
            return 'Your recent weight trend matches your goal';
        case 'faster':
            return 'Your recent weight trend is faster than your goal';
        case 'slower':
            return 'Your recent weight trend is slower than your goal';
        case 'above_maintenance':
            return 'Your recent weight trend is above maintenance';
        case 'below_maintenance':
            return 'Your recent weight trend is below maintenance';
    }
}

/** Selects the aligned or speedometer icon for the assessed pace. */
export function paceIcon(status: CalibrationPaceStatus): React.ComponentProps<typeof Ionicons>['name'] {
    return status === 'aligned' ? 'checkmark-circle-outline' : 'speedometer-outline';
}

/** Maps the assessment blocker to the next useful plan-check instruction. */
export function waitingTitle(blocker: CalibrationAssessmentBlocker | null): string {
    switch (blocker) {
        case 'tracking_paused':
            return 'Plan check is paused';
        case 'current_weigh_in':
            return 'Add a current weigh-in';
        case 'weight_uncertainty':
            return 'Your weight trend is still taking shape';
        case 'plan_unavailable':
            return 'Review your calorie plan';
        case 'trend_unavailable':
            return 'Your weight trend is unavailable';
        default:
            return 'Not enough history for a reliable plan check';
    }
}
