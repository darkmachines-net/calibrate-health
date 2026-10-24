/** @file Regression coverage for Date Navigation web: DateNavigation web. */

import React from 'react';
import { StyleSheet } from 'react-native';
import { DateNavigation } from './DateNavigation.web';
import type { LogDateNavigation } from '../hooks/useLogDateNavigation';

type TestInstance = {
    props: Record<string, unknown>;
    findByType: (type: string) => TestInstance;
    findByProps: (props: Record<string, unknown>) => TestInstance;
};

const testRenderer = require('react-test-renderer') as {
    act: (callback: () => void) => void;
    create: (
        element: React.ReactElement,
        options?: { createNodeMock: (element: { type: unknown }) => unknown }
    ) => { root: TestInstance };
};

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('../food/HistoricalDatePicker', () => {
    const ReactModule = require('react') as typeof import('react');
    return {
        HistoricalDatePicker: (props: Record<string, unknown>) =>
            ReactModule.createElement('historical-date-picker', props)
    };
});
jest.mock('../theme', () => ({
    useAppTheme: () => ({
        colors: {
            primary: '#2e7d32',
            onSurface: '#172217',
            onSurfaceVariant: '#526052',
            surfaceContainer: '#eef3eb',
            surfaceContainerLow: '#f5f8f3',
            surfacePressed: '#e2eadf',
            outlineVariant: '#cdd7c9'
        },
        interaction: { minimumTouchTarget: 48 },
        radius: { md: 12 },
        stroke: { control: 1 },
        spacing: { xs: 4, sm: 8, md: 16 },
        typography: {
            title: 28,
            screenTitle: 24,
            subtitle: 20,
            body: 16,
            small: 14,
            metric: 34,
            caption: 12,
            styles: {
                page: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
                section: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
                card: { fontSize: 16, lineHeight: 22, fontWeight: '700' },
                body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
                label: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
                caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
                metric: { fontSize: 32, lineHeight: 38, fontWeight: '800' }
            }
        }
    })
}));

describe('DateNavigation web', () => {
    it('opens the decorated history calendar and forwards date selection', () => {
        const setDate = jest.fn();
        const navigation: LogDateNavigation = {
            selectedDate: '2026-07-17',
            selectedDateLabel: 'Jul 17, 2026',
            today: '2026-07-18',
            minDate: '2026-01-01',
            maxDate: '2026-07-18',
            isToday: false,
            canGoBack: true,
            canGoForward: true,
            goToPreviousDate: jest.fn(),
            goToNextDate: jest.fn(),
            goToToday: jest.fn(),
            setDate
        };
        let tree: { root: TestInstance };

        testRenderer.act(() => {
            tree = testRenderer.create(<DateNavigation navigation={navigation} />);
        });

        const trigger = tree!.root.findByProps({ accessibilityLabel: 'Choose date' });
        testRenderer.act(() => {
            (trigger.props.onPress as () => void)();
        });

        const picker = tree!.root.findByType('historical-date-picker');
        expect(picker.props).toMatchObject({
            visible: true,
            selectedDate: '2026-07-17',
            minDate: '2026-01-01',
            maxDate: '2026-07-18'
        });
        testRenderer.act(() => {
            (picker.props.onSelectDate as (date: string) => void)('2026-07-16');
        });
        expect(setDate).toHaveBeenCalledWith('2026-07-16');

        testRenderer.act(() => {
            (picker.props.onRequestClose as () => void)();
        });
        expect(tree!.root.findByType('historical-date-picker').props.visible).toBe(false);
    });

    it('uses compact spacing without clamping the selected date', () => {
        const navigation: LogDateNavigation = {
            selectedDate: '2026-07-17',
            selectedDateLabel: 'Jul 17, 2026',
            today: '2026-07-18',
            minDate: '2026-01-01',
            maxDate: '2026-07-18',
            isToday: false,
            canGoBack: true,
            canGoForward: true,
            goToPreviousDate: jest.fn(),
            goToNextDate: jest.fn(),
            goToToday: jest.fn(),
            setDate: jest.fn()
        };
        let tree: { root: TestInstance };

        testRenderer.act(() => {
            tree = testRenderer.create(<DateNavigation navigation={navigation} compact />);
        });

        const toolbar = tree!.root.findByProps({ accessibilityRole: 'toolbar' });
        const trigger = tree!.root.findByProps({ accessibilityLabel: 'Choose date' });
        const dateText = trigger.findByProps({ children: 'Jul 17, 2026' });
        const triggerStyle = trigger.props.style as (state: { pressed: boolean }) => unknown;

        expect(StyleSheet.flatten(toolbar.props.style)).toMatchObject({ gap: 8 });
        expect(StyleSheet.flatten(triggerStyle({ pressed: false }))).toMatchObject({ paddingHorizontal: 8 });
        expect(dateText.props.numberOfLines).toBeUndefined();
    });
});
