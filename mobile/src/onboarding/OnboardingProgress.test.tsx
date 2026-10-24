/** @file Regression coverage for Onboarding Progress: OnboardingProgress. */

import { render } from '@testing-library/react-native';
import { OnboardingProgress } from './OnboardingProgress';

describe('OnboardingProgress', () => {
    it.each([0, 1, 2])('announces the current required step at index %i', (activeIndex) => {
        const screen = render(<OnboardingProgress activeIndex={activeIndex} />);
        const text = `Step ${activeIndex + 1} of 3`;
        expect(screen.getByText(text)).toBeTruthy();
        expect(screen.getByRole('progressbar', { name: 'Onboarding progress' }).props.accessibilityValue)
            .toEqual({ min: 1, max: 3, now: activeIndex + 1, text });
    });
});
