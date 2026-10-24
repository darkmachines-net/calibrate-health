/** @file Guards query invalidation when the active user-local date changes. */

import { renderHook } from '@testing-library/react-native';
import { useLocalDayRefresh } from './useLocalDayRefresh';
import { foodDayRangeQueryRoot } from '../food/calendar';
import { foodTrackingPauseQueryKey } from '../food/queryKeys';

const mockQueryClient = { invalidateQueries: jest.fn(async () => undefined) };
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => mockQueryClient }));

it('refreshes day-sensitive data only on a local-date change', () => {
    const { rerender } = renderHook(({ today }: { today: string }) => useLocalDayRefresh(today), { initialProps: { today: '2026-07-21' } });
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalled();
    rerender({ today: '2026-07-22' });
    expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['mobile-food-day'] });
    expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: foodDayRangeQueryRoot });
    expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: foodTrackingPauseQueryKey });
    const count = mockQueryClient.invalidateQueries.mock.calls.length;
    rerender({ today: '2026-07-22' });
    expect(mockQueryClient.invalidateQueries).toHaveBeenCalledTimes(count);
});
