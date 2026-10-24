/** @file Regression coverage for Progress Bar: ProgressBar. */

import { render } from '@testing-library/react-native';
import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
    it('exposes a clamped percentage to assistive technology', async () => {
        const screen = await render(<ProgressBar value={1.4} accessibilityLabel="Goal progress" />);
        const progress = screen.getByRole('progressbar', { name: 'Goal progress' });

        expect(progress.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 100 });
        expect(progress.props['aria-valuemin']).toBe(0);
        expect(progress.props['aria-valuemax']).toBe(100);
        expect(progress.props['aria-valuenow']).toBe(100);
    });
});
