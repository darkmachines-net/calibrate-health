/** @file Regression coverage for add Food Route: legacy add-food route. */

import { render, waitFor } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import LogScreen from '../../app/(tabs)/(today)/log';

const mockRequestAddFood = jest.fn();

jest.mock('expo-router', () => ({
    router: { replace: jest.fn() },
    useLocalSearchParams: jest.fn()
}));

jest.mock('../context/AddFoodRequestContext', () => ({
    useAddFoodRequest: () => ({ requestAddFood: mockRequestAddFood })
}));

const mockUseLocalSearchParams = useLocalSearchParams as jest.MockedFunction<typeof useLocalSearchParams>;
const mockReplace = router.replace as jest.MockedFunction<typeof router.replace>;

describe('legacy add-food route', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('hands the request to Today before replacing the modal-only route', async () => {
        mockUseLocalSearchParams.mockReturnValue({ date: '2026-07-17', meal: 'DINNER' });

        render(<LogScreen />);

        await waitFor(() => {
            expect(mockRequestAddFood).toHaveBeenCalledWith({ date: '2026-07-17', meal: 'DINNER' });
            expect(mockReplace).toHaveBeenCalledWith({
                pathname: '/today',
                params: {
                    openAddFood: 'true',
                    date: '2026-07-17',
                    meal: 'DINNER'
                }
            });
        });
    });

    it('drops an invalid meal supplied by an external route', async () => {
        mockUseLocalSearchParams.mockReturnValue({ date: '2026-07-17', meal: 'MIDNIGHT_FEAST' as never });

        render(<LogScreen />);

        await waitFor(() => {
            expect(mockRequestAddFood).toHaveBeenCalledWith({ date: '2026-07-17', meal: undefined });
            expect(mockReplace).toHaveBeenCalledWith({
                pathname: '/today',
                params: {
                    openAddFood: 'true',
                    date: '2026-07-17',
                    meal: undefined
                }
            });
        });
    });
});
