/** @file Regression coverage for use Barcode Search Handoff: useBarcodeSearchHandoff. */

import { renderHook, waitFor } from '@testing-library/react-native';
import { MEAL_PERIODS } from '@calibrate/shared';
import { useBarcodeSearchHandoff, type BarcodeSearchHandoffParams } from './useBarcodeSearchHandoff';

describe('useBarcodeSearchHandoff', () => {
    it('activates the requested date, opens once, and scrubs transient route params', async () => {
        const setDate = jest.fn();
        const openSheet = jest.fn();
        const scrubParams = jest.fn();
        const params: BarcodeSearchHandoffParams = {
            openAddFood: 'true',
            date: '2026-08-09',
            meal: MEAL_PERIODS.DINNER
        };
        const harness = renderHook(
            ({ selectedDate, nextParams }: { selectedDate: string; nextParams: BarcodeSearchHandoffParams }) =>
                useBarcodeSearchHandoff({
                    params: nextParams,
                    selectedDate,
                    enabled: true,
                    setDate,
                    openSheet,
                    scrubParams
                }),
            { initialProps: { selectedDate: '2026-08-08', nextParams: params } }
        );

        await waitFor(() => expect(setDate).toHaveBeenCalledWith('2026-08-09'));
        expect(openSheet).not.toHaveBeenCalled();

        harness.rerender({ selectedDate: '2026-08-09', nextParams: params });
        await waitFor(() => expect(openSheet).toHaveBeenCalledWith(MEAL_PERIODS.DINNER));
        expect(scrubParams).toHaveBeenCalledWith('2026-08-09');

        harness.rerender({ selectedDate: '2026-08-09', nextParams: params });
        expect(openSheet).toHaveBeenCalledTimes(1);
        expect(scrubParams).toHaveBeenCalledTimes(1);
    });

    it('drops an invalid meal while retaining the requested date', async () => {
        const openSheet = jest.fn();
        const scrubParams = jest.fn();
        renderHook(() => useBarcodeSearchHandoff({
            params: { openAddFood: 'true', date: '2026-08-09', meal: 'MIDNIGHT_FEAST' },
            selectedDate: '2026-08-09',
            enabled: true,
            setDate: jest.fn(),
            openSheet,
            scrubParams
        }));

        await waitFor(() => expect(openSheet).toHaveBeenCalledWith(null));
        expect(scrubParams).toHaveBeenCalledWith('2026-08-09');
    });
});
