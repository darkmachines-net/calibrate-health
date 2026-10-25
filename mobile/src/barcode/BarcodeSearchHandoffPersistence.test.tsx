/** @file Regression coverage for Barcode Search Handoff Persistence: barcode Search foods handoff persistence. */

import { useState } from 'react';
import { Text } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';
import { MEAL_PERIODS, type MealPeriod } from '@calibrate/shared';
import {
    useBarcodeSearchHandoff,
    type BarcodeSearchHandoffParams
} from './useBarcodeSearchHandoff';

function HandoffHarness() {
    const [params, setParams] = useState<BarcodeSearchHandoffParams>({
        openAddFood: 'true',
        date: '2026-08-09',
        meal: MEAL_PERIODS.DINNER
    });
    const [openMeal, setOpenMeal] = useState<MealPeriod | null>(null);
    useBarcodeSearchHandoff({
        params,
        selectedDate: '2026-08-09',
        enabled: true,
        setDate: jest.fn(),
        openSheet: setOpenMeal,
        // Mirrors router.setParams: update params without remounting the route component.
        scrubParams: (date) => setParams({ date })
    });
    return (
        <>
            <Text>{openMeal ? `Add food ${openMeal}` : 'Sheet closed'}</Text>
            <Text>{params.openAddFood ? 'Params pending' : 'Params scrubbed'}</Text>
        </>
    );
}

describe('barcode Search foods handoff persistence', () => {
    it('keeps the Add food sheet open after transient route params are scrubbed in place', async () => {
        const screen = await render(<HandoffHarness />);

        await waitFor(() => expect(screen.getByText('Add food DINNER')).toBeTruthy());
        expect(screen.getByText('Params scrubbed')).toBeTruthy();
    });
});
