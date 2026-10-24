/** @file Regression coverage for steps: onboarding sequence. */

import { ONBOARDING_STEPS } from './steps';

describe('onboarding sequence', () => {
    it('has the same three required steps on every platform', () => {
        expect(ONBOARDING_STEPS.map(({ key }) => key)).toEqual(['about', 'activity', 'plan']);
        expect(ONBOARDING_STEPS.map(({ title }) => title)).toEqual(['About you', 'Activity', 'Your plan']);
    });
});
