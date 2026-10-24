/** @file Regression coverage for Form Field: FormField. */

import { render, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, TextInput } from 'react-native';
import { FormField, type FocusableFormControl } from './FormField';

describe('FormField', () => {
    it('associates its visible label, helper, and error with the control', () => {
        let receivedProps: Record<string, unknown> | undefined;
        const screen = render(
            <FormField
                label="Email address"
                helperText="Used to sign in."
                errorText="Enter a valid email."
                required
            >
                {(controlProps) => {
                    receivedProps = controlProps;
                    return <TextInput {...controlProps} testID="email-input" />;
                }}
            </FormField>
        );

        expect(screen.getByTestId('email-input')).toBeTruthy();
        expect(receivedProps?.['aria-invalid']).toBe(true);
        expect(receivedProps?.['aria-required']).toBe(true);
        expect(receivedProps?.['aria-labelledby']).toContain('-label');
        expect(receivedProps?.['aria-describedby']).toContain('-error');
        expect(receivedProps?.['aria-describedby']).toContain('-helper');
        expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email.');
    });

    it('focuses and announces the invalid field only when focusError is requested', async () => {
        const focus = jest.fn();
        const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(jest.fn());
        const controlRef = { current: { focus } as FocusableFormControl };
        const screen = render(
            <FormField label="Name" errorText="Name is required." controlRef={controlRef} focusError>
                {(controlProps) => <TextInput {...controlProps} />}
            </FormField>
        );

        await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
        expect(announce).toHaveBeenCalledWith('Name is required.');

        screen.rerender(
            <FormField label="Name" errorText="Name is required." controlRef={controlRef} focusError>
                {(controlProps) => <TextInput {...controlProps} />}
            </FormField>
        );
        expect(focus).toHaveBeenCalledTimes(1);

        screen.rerender(
            <FormField label="Name" controlRef={controlRef} focusError>
                {(controlProps) => <TextInput {...controlProps} />}
            </FormField>
        );
        screen.rerender(
            <FormField label="Name" errorText="Name is required." controlRef={controlRef} focusError>
                {(controlProps) => <TextInput {...controlProps} />}
            </FormField>
        );
        await waitFor(() => expect(focus).toHaveBeenCalledTimes(2));
        expect(announce).toHaveBeenCalledTimes(2);
        announce.mockRestore();
    });

    it('keeps hidden labels accessible without pointing to a missing label node', () => {
        let receivedProps: Record<string, unknown> | undefined;
        const screen = render(
            <FormField label="Search foods" hideLabel>
                {(controlProps) => {
                    receivedProps = controlProps;
                    return <TextInput {...controlProps} testID="search-input" />;
                }}
            </FormField>
        );

        expect(screen.getByTestId('search-input')).toBeTruthy();
        expect(receivedProps?.['aria-labelledby']).toBeUndefined();
        expect(screen.queryByText('Search foods')).toBeNull();
    });
});
