/** @file Regression coverage for Date Navigation Header: DateNavigationHeader. */

import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import type { LogDateNavigation } from '../hooks/useLogDateNavigation';
import { DateNavigationHeader } from './DateNavigationHeader';
import { SCREEN_CONTENT_WIDTHS, SCREEN_WIDE_LAYOUT_BREAKPOINT } from './Screen';

type TestInstance = {
    props: Record<string, unknown>;
    findByProps: (props: Record<string, unknown>) => TestInstance;
    findByType: (type: string) => TestInstance;
};

const testRenderer = require('react-test-renderer') as {
    act: (callback: () => void) => void;
    create: (element: React.ReactElement) => { root: TestInstance };
};

let mockWindowWidth = 1_024;
let mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: () => ({ width: mockWindowWidth, height: 768, scale: 1, fontScale: 1 })
}));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => mockSafeAreaInsets
}));
jest.mock('../theme', () => ({
    spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
    useAppTheme: () => ({
        colors: {
            border: '#cdd7c9',
            background: '#faf9f6',
            summaryContainer: '#f2f7f2',
            surface: '#ffffff'
        }
    })
}));
jest.mock('./DateNavigation', () => {
    return {
        DateNavigation: 'date-navigation'
    };
});

const navigation: LogDateNavigation = {
    selectedDate: '2026-08-08',
    selectedDateLabel: 'Aug 8, 2026',
    today: '2026-08-08',
    minDate: '2026-07-01',
    maxDate: '2026-08-08',
    isToday: true,
    canGoBack: true,
    canGoForward: false,
    goToPreviousDate: jest.fn(),
    goToNextDate: jest.fn(),
    goToToday: jest.fn(),
    setDate: jest.fn()
};

describe('DateNavigationHeader', () => {
    const originalPlatformOS = Platform.OS;

    beforeEach(() => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        mockWindowWidth = SCREEN_WIDE_LAYOUT_BREAKPOINT;
        mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
    });

    afterEach(() => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
    });

    it.each(['web', 'ios', 'android'])('aligns date navigation with tablet content on %s', (platform) => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        let tree: { root: TestInstance };

        testRenderer.act(() => {
            tree = testRenderer.create(<DateNavigationHeader navigation={navigation} />);
        });

        const dateNavigation = tree!.root.findByType('date-navigation');
        const content = tree!.root.findByProps({ testID: 'date-navigation-header-content' });
        const shell = tree!.root.findByProps({ testID: 'date-navigation-header' });

        expect(dateNavigation.props).toMatchObject({ navigation, compact: true, unified: true });
        expect(StyleSheet.flatten(content.props.style)).toMatchObject({
            width: '100%',
            maxWidth: SCREEN_CONTENT_WIDTHS.wide,
            alignSelf: 'center',
            paddingLeft: 32,
            paddingRight: 32,
            paddingTop: 4,
            paddingBottom: 8
        });
        expect(StyleSheet.flatten(shell.props.style)).toMatchObject({
            backgroundColor: '#f2f7f2'
        });
    });

    it.each(['web', 'ios', 'android'])('keeps compact gutters below tablet width on %s', (platform) => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        mockWindowWidth = SCREEN_WIDE_LAYOUT_BREAKPOINT - 1;
        let tree: { root: TestInstance };

        testRenderer.act(() => {
            tree = testRenderer.create(<DateNavigationHeader navigation={navigation} />);
        });

        const content = tree!.root.findByProps({ testID: 'date-navigation-header-content' });
        const style = StyleSheet.flatten(content.props.style);
        expect(style).toMatchObject({ paddingLeft: 24, paddingRight: 24 });
        expect(style).not.toHaveProperty('maxWidth');
    });

    it.each([
        { left: 44, right: 0, paddingLeft: 52, paddingRight: 32 },
        { left: 0, right: 44, paddingLeft: 32, paddingRight: 52 }
    ])('protects native date controls from horizontal cutouts: %o', (insets) => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        mockSafeAreaInsets = { top: 0, bottom: 0, left: insets.left, right: insets.right };
        let tree: { root: TestInstance };

        testRenderer.act(() => {
            tree = testRenderer.create(<DateNavigationHeader navigation={navigation} />);
        });

        const content = tree!.root.findByProps({ testID: 'date-navigation-header-content' });
        expect(StyleSheet.flatten(content.props.style)).toMatchObject({
            paddingLeft: insets.paddingLeft,
            paddingRight: insets.paddingRight
        });
    });
});
