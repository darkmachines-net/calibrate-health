/** @file Canonical onboarding step identities, order, and screen labels. */

export type OnboardingStepKey = 'about' | 'activity' | 'plan';

export type OnboardingStep = {
    key: OnboardingStepKey;
    title: string;
    description: string;
};

export const ONBOARDING_STEPS: OnboardingStep[] = [
    { key: 'about', title: 'About you', description: 'A few details to find your starting calorie target.' },
    { key: 'activity', title: 'Activity', description: 'Choose what best describes a typical week, including work and exercise. You can change this later.' },
    { key: 'plan', title: 'Your plan', description: 'Choose your goal and a pace that works for you.' }
];
