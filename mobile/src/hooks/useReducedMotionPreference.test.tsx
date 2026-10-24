/** @file Regression coverage for use Reduced Motion Preference: useReducedMotionPreference. */

import { AccessibilityInfo } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import { AppText } from '../components/AppText';
import { useReducedMotionPreference } from './useReducedMotionPreference';

function Probe() {
    const reduced = useReducedMotionPreference();
    return <AppText>{reduced ? 'reduced' : 'animated'}</AppText>;
}

describe('useReducedMotionPreference', () => {
    it('hydrates and responds to the Android reduce-motion preference', async () => {
        let listener: ((enabled: boolean) => void) | undefined;
        jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
        jest.spyOn(AccessibilityInfo as any, 'addEventListener').mockImplementation((...args: unknown[]) => {
            const [event, callback] = args;
            if (event === 'reduceMotionChanged') listener = callback as (enabled: boolean) => void;
            return { remove: jest.fn() };
        });

        const view = render(<Probe />);
        await waitFor(() => expect(view.getByText('reduced')).toBeTruthy());
        act(() => listener?.(false));
        await waitFor(() => expect(view.getByText('animated')).toBeTruthy());
    });
});
