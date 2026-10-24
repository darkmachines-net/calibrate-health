/** @file Regression coverage for Time Zone Picker Field: TimeZonePickerField. */

import { fireEvent, render } from '@testing-library/react-native';
import { TimeZonePickerField } from './TimeZonePickerField';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

jest.mock('../utils/timezones', () => {
    const actual = jest.requireActual('../utils/timezones');
    return {
        ...actual,
        detectDeviceTimeZone: () => 'America/Los_Angeles'
    };
});

describe('TimeZonePickerField', () => {
    it('offers the permission-free device timezone as a clear action', () => {
        const onChange = jest.fn();
        const screen = render(<TimeZonePickerField value="America/New_York" onChange={onChange} />);

        expect(screen.getByText('Pacific Time (Los Angeles)')).toBeTruthy();
        expect(screen.getByText('Detected from device settings: America/Los_Angeles')).toBeTruthy();
        fireEvent.press(screen.getByText('Use device time zone'));
        expect(onChange).toHaveBeenCalledWith('America/Los_Angeles');
    });

    it('keeps manual IANA input behind an advanced affordance and validates before applying', () => {
        const onChange = jest.fn();
        const screen = render(<TimeZonePickerField value="America/New_York" onChange={onChange} />);

        expect(screen.queryByLabelText('IANA time zone')).toBeNull();
        fireEvent.press(screen.getByText('Enter IANA time zone manually'));

        const input = screen.getByLabelText('IANA time zone');
        fireEvent.changeText(input, 'Mars/Olympus_Mons');
        expect(screen.getByText('Enter a valid IANA time zone.')).toBeTruthy();
        fireEvent.press(screen.getByText('Apply manual time zone'));
        expect(onChange).not.toHaveBeenCalled();

        fireEvent.changeText(input, 'Europe/Paris');
        fireEvent.press(screen.getByText('Apply manual time zone'));
        expect(onChange).toHaveBeenCalledWith('Europe/Paris');
    });
});
