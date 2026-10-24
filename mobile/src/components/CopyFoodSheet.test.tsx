/** @file Regression coverage for Copy Food Sheet: CopyFoodSheet. */

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { CopyFoodSheet, getDefaultCopyTargetDate } from './CopyFoodSheet';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

jest.mock('./BottomSheetModal', () => {
    const ReactModule = require('react');
    const { View } = require('react-native');
    return {
        BottomSheetModal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
            visible ? ReactModule.createElement(View, null, children) : null
    };
});

jest.mock('./DatePickerField', () => {
    const ReactModule = require('react');
    const { Pressable, Text } = require('react-native');
    return {
        DatePickerField: ({ label, onChangeDate }: { label: string; onChangeDate: (value: string) => void }) =>
            ReactModule.createElement(
                Pressable,
                { accessibilityRole: 'button', accessibilityLabel: label, onPress: () => onChangeDate('2026-07-21') },
                ReactModule.createElement(Text, null, label)
            )
    };
});

jest.mock('./OverlaySelect', () => {
    const ReactModule = require('react');
    const { Pressable, Text } = require('react-native');
    return {
        OverlaySelect: ({ accessibilityLabel, onChange }: {
            accessibilityLabel: string;
            onChange: (value: string) => void;
        }) => ReactModule.createElement(
            Pressable,
            { accessibilityRole: 'button', accessibilityLabel, onPress: () => onChange('LUNCH') },
            ReactModule.createElement(Text, null, accessibilityLabel)
        )
    };
});

describe('CopyFoodSheet', () => {
    it('defaults toward the closest available day without crossing date bounds', () => {
        expect(getDefaultCopyTargetDate('2026-07-20', '2026-07-01', '2026-07-21')).toBe('2026-07-21');
        expect(getDefaultCopyTargetDate('2026-07-21', '2026-07-01', '2026-07-21')).toBe('2026-07-20');
        expect(getDefaultCopyTargetDate('2026-07-21', '2026-07-21', '2026-07-21')).toBe('2026-07-21');
    });

    it('allows a meal to move across meal periods on the same local date', async () => {
        const onSubmit = jest.fn();
        const screen = await render(
            <CopyFoodSheet
                visible
                source={{ kind: 'meal', meal: 'BREAKFAST' }}
                sourceDate="2026-07-21"
                minDate="2026-07-01"
                maxDate="2026-07-21"
                onRequestClose={jest.fn()}
                onSubmit={onSubmit}
            />
        );

        await fireEvent.press(screen.getByRole('button', { name: 'Copy to meal' }));
        await fireEvent.press(screen.getByRole('button', { name: 'Copy to date' }));
        await fireEvent.press(screen.getByRole('button', { name: 'Copy meal' }));

        expect(onSubmit).toHaveBeenCalledWith({ kind: 'meal', targetDate: '2026-07-21', targetMeal: 'LUNCH' });
    });

    it('prevents a whole-day copy from targeting its source day', async () => {
        const screen = await render(
            <CopyFoodSheet
                visible
                source={{ kind: 'day' }}
                sourceDate="2026-07-21"
                minDate="2026-07-01"
                maxDate="2026-07-21"
                onRequestClose={jest.fn()}
                onSubmit={jest.fn()}
            />
        );

        await fireEvent.press(screen.getByRole('button', { name: 'Copy to date' }));

        expect(screen.getByText('Choose a different day.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Copy day' })).toBeDisabled();
    });
});