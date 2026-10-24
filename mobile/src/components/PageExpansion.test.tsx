/** @file Regression coverage for Page Expansion: native expansion Back handling. */

import React from 'react';
import { Animated, BackHandler, Pressable, StyleSheet, View } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ExpansionRegion, PageExpansion, useExpansionMotion, type PageExpansionConfig } from './PageExpansion';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
let mockReducedMotion = true;
jest.mock('../hooks/useReducedMotionPreference', () => ({ useReducedMotionPreference: () => mockReducedMotion }));

describe('native expansion Back handling', () => {
    afterEach(() => jest.restoreAllMocks());

    it('consumes Back only for the expanded active page and releases it on collapse', async () => {
        const remove = jest.fn();
        let onBack: Parameters<typeof BackHandler.addEventListener>[1] | undefined;
        const listen = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, listener) => {
            onBack = listener;
            return { remove };
        });
        const onClose = jest.fn();
        const config: PageExpansionConfig = { id: null, title: 'Food log', backLabel: 'Back to Today', onClose, onRestore: jest.fn(), renderContent: () => null };
        const page = (value: PageExpansionConfig) => <PageExpansion config={value} columnStyle={undefined}>{() => null}</PageExpansion>;
        const view = await render(page(config));
        expect(listen).not.toHaveBeenCalled();
        await view.rerender(page({ ...config, id: 'food', focused: false }));
        expect(listen).not.toHaveBeenCalled();
        await view.rerender(page({ ...config, id: 'food', focused: true }));
        expect(listen).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
        await act(() => expect(onBack?.({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(true));
        expect(onClose).toHaveBeenCalledTimes(1);
        await view.rerender(page(config));
        expect(remove).toHaveBeenCalledTimes(1);
    });
});

it.each([450, 180])('shrinks on every native cycle after %i ms of expansion', async (openingTime) => {
    jest.useFakeTimers();
    mockReducedMotion = false;
    let sourceY = 200;
    let progress: Animated.Value | undefined;
    const measure = jest.spyOn(View.prototype, 'measureInWindow').mockImplementation(function (this: { props: { testID?: string } }, callback) {
        const isSource = this.props.testID === 'trend-source';
        (callback as (x: number, y: number, width: number, height: number) => void)(0, isSource ? sourceY : 0, 412, isSource ? 260 : 680);
    });
    function MotionConsumer() {
        const motion = useExpansionMotion('trend');
        if (motion) progress = motion.progress;
        return null;
    }
    function Example() {
        const [id, setId] = React.useState<string | null>(null);
        return <PageExpansion columnStyle={undefined} config={{
            id, title: 'Trend', backLabel: 'Back to Progress', onClose: () => setId(null), onRestore: setId,
            focused: false, renderContent: () => <View testID="trend-detail" />
        }}>{() => <ExpansionRegion id="trend" order={2} testID="trend-source">
            <MotionConsumer />
            <Pressable accessibilityLabel="Expand Trend" onPress={() => setId('trend')} />
        </ExpansionRegion>}</PageExpansion>;
    }
    const screen = await render(<Example />);
    try {
        for (let cycle = 0; cycle < 3; cycle++) {
            sourceY = 200;
            await fireEvent.press(screen.getByLabelText('Expand Trend'));
            await act(() => jest.advanceTimersByTime(openingTime));
            const opening = StyleSheet.flatten(screen.getByTestId('expanded-trend').props.style);
            expect(opening.top).toBeLessThan(200);
            expect(opening.height).toBeGreaterThan(260);
            if (openingTime === 450) {
                expect(screen.getByTestId('expanded-trend')).toHaveStyle({ top: 0, height: 680 });
            }
            // Native measurement includes the source's translation, even mid-expansion.
            sourceY = opening.top;
            await fireEvent.press(screen.getByRole('button', { name: 'Back to Progress' }));
            await fireEvent.press(screen.getByRole('button', { name: 'Back to Progress' })); // A repeated tap must not stop collapse.
            await act(() => jest.advanceTimersByTime(180));
            const middle = StyleSheet.flatten(screen.getByTestId('expanded-trend').props.style);
            expect(middle.top).toBeGreaterThan(opening.top);
            expect(middle.top).toBeLessThan(200);
            expect(middle.height).toBeGreaterThan(260);
            expect(middle.height).toBeLessThan(opening.height);
            expect(screen.getByTestId('trend-detail')).toBeTruthy();
            await act(() => jest.advanceTimersByTime(250));
            expect(screen.queryByTestId('expanded-trend')).toBeNull();
            expect(screen.getByLabelText('Expand Trend')).toBeTruthy();
            // Native AnimatedNode.__detach clears listeners when its last view detaches.
            // Test-renderer host views do not perform that native attachment cleanup.
            await act(() => progress!.removeAllListeners());
        }
    } finally {
        await screen.unmount();
        measure.mockRestore();
        jest.useRealTimers();
        mockReducedMotion = true;
    }
});
