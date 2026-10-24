/** @file Regression coverage for presentation: calorie plan presentation. */

import { getCaloriePlanPresentation } from './presentation';

describe('calorie plan presentation', () => {
    it.each([
        ['DATE_OF_BIRTH_REQUIRED', 'profile'],
        ['HEIGHT_OUT_OF_RANGE', 'profile'],
        ['LATEST_WEIGHT_REQUIRED', 'weight'],
        ['WEIGHT_OUT_OF_RANGE', 'weight'],
        ['GOAL_REQUIRED', 'goal'],
        ['TARGET_BELOW_MINIMUM', 'goal']
    ] as const)('maps %s to the %s action', (reasonCode, actionKind) => {
        expect(getCaloriePlanPresentation(reasonCode).actionKind).toBe(actionKind);
    });

    it.each(['HEIGHT_OUT_OF_RANGE', 'WEIGHT_OUT_OF_RANGE'] as const)(
        'keeps %s copy neutral across display units',
        (reasonCode) => {
            const message = getCaloriePlanPresentation(reasonCode).message;
            expect(message).not.toMatch(/\b(?:cm|kg)\b/i);
            expect(message).toContain('selected units');
        }
    );

    it('routes a resolved sticky prerequisite review to goal replacement', () => {
        const presentation = getCaloriePlanPresentation('HISTORICAL_PLAN_REQUIRES_REVIEW', 'requires_review');

        expect(presentation.actionKind).toBe('goal');
        expect(presentation.actionLabel).toBe('Review calorie plan');
        expect(presentation.message).toContain('replaced before targets resume');
    });
});
