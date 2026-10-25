/** @file Regression coverage for weight Trend Route: WeightTrendScreen. */

import { render } from '@testing-library/react-native';
import WeightTrendScreen from '../../app/(tabs)/(progress)/weight-trend';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}));
jest.mock('../components/WeightTrendCard', () => ({
    WeightTrendCard: () => null
}));

describe('WeightTrendScreen', () => {
    it('leaves route navigation to the shared tab header', async () => {
        const screen = await render(<WeightTrendScreen />);
        expect(screen.queryByLabelText('Back to Progress')).toBeNull();
    });
});
