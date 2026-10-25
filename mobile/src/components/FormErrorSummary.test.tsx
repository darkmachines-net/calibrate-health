/** @file Regression coverage for Form Error Summary: FormErrorSummary. */

import { createRef } from 'react';
import { AccessibilityInfo } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { FormErrorSummary, type FormErrorSummaryHandle } from './FormErrorSummary';

describe('FormErrorSummary', () => {
    it('exposes an alert target and announces its message when focused', async () => {
        const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
        const focusRef = createRef<FormErrorSummaryHandle>();
        const { getByRole } = await render(
                <FormErrorSummary ref={focusRef} message="Enter a valid serving and calorie value." />
        );

        expect(getByRole('alert')).toHaveProp('tabIndex', -1);
        await act(() => focusRef.current?.focus());
        expect(announce).toHaveBeenCalledWith('Enter a valid serving and calorie value.');
    });
});
