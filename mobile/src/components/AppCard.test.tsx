/** @file Regression coverage for App Card: AppCard. */

import { render } from '@testing-library/react-native';
import { AppCard } from './AppCard';
import { spacing } from '../theme';

describe('AppCard', () => {
    it('uses uniform compact dashboard insets', () => {
        const screen = render(<AppCard density="compact" testID="card" />);

        expect(screen.getByTestId('card')).toHaveStyle({
            padding: spacing.md,
            paddingTop: spacing.md,
            gap: spacing.sm
        });
    });
});
