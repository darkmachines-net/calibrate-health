/** @file Covers the keyboard scroller's focus bounds, optional context, and inset ownership. */

import { Keyboard, StyleSheet } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { AppText } from './AppText';
import { KeyboardAwareScrollView, resolveFocusedFieldOffset } from './KeyboardAwareScrollView';

describe('resolveFocusedFieldOffset', () => {
    it.each([
        [120, 48, 100, 100, 100],
        [180, 48, 100, 100, 136],
        [60, 48, 100, 100, 52],
        [100, 96, 80, 64, 100],
        [100, 48, 80, 50, 99]
    ])('fits a field at %d with height %d, scroll offset %d and viewport %d', (top, height, offset, viewport, expected) => {
        expect(resolveFocusedFieldOffset(top, height, offset, viewport)).toBe(expected);
    });

    it('reveals context when there is room and prioritizes the field on a short viewport', () => {
        expect(resolveFocusedFieldOffset(180, 48, 100, 130, 60)).toBe(166);
        expect(resolveFocusedFieldOffset(180, 48, 100, 100, 60)).toBe(136);
    });
});

describe('KeyboardAwareScrollView', () => {
    const keyboardListeners: Partial<Record<string, () => void>> = {};

    beforeEach(() => {
        jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
        jest.spyOn(Keyboard, 'addListener').mockImplementation((event, listener) => {
            keyboardListeners[event] = listener as () => void;
            return { remove: jest.fn() } as unknown as ReturnType<typeof Keyboard.addListener>;
        });
    });

    afterEach(() => {
        Object.keys(keyboardListeners).forEach((event) => delete keyboardListeners[event]);
        jest.restoreAllMocks();
    });

    it('uses form-friendly keyboard interaction defaults', async () => {
        const view = await render(
            <KeyboardAwareScrollView testID="keyboard-scroller">
                <AppText>Form content</AppText>
            </KeyboardAwareScrollView>
        );

        const scroller = view.container.queryAll((node) => node.type === 'RCTScrollView')[0];
        expect(scroller.props.keyboardDismissMode).toBe('on-drag');
        expect(scroller.props.keyboardShouldPersistTaps).toBe('handled');
        expect(scroller.props.showsVerticalScrollIndicator).toBe(false);
    });

    it('does not move the viewport merely because an input receives focus', async () => {
        const animationFrame = jest.spyOn(global, 'requestAnimationFrame').mockImplementation(() => 1);
        const view = await render(
            <KeyboardAwareScrollView>
                <AppText>Form content</AppText>
            </KeyboardAwareScrollView>
        );

        await act(() => {
            view.container.queryAll((node) => node.type === 'RCTScrollView')[0].props.onFocus({ target: {} });
        });

        expect(animationFrame).not.toHaveBeenCalled();
    });

    it('can reveal a focused field immediately for keyboard-first editors', async () => {
        const animationFrame = jest.spyOn(global, 'requestAnimationFrame').mockImplementation(() => 1);
        const view = await render(
            <KeyboardAwareScrollView revealFocusedInputOnFocus>
                <AppText>Form content</AppText>
            </KeyboardAwareScrollView>
        );

        await act(() => {
            view.container.queryAll((node) => node.type === 'RCTScrollView')[0].props.onFocus({ target: {} });
        });

        expect(animationFrame).toHaveBeenCalledTimes(1);
    });

    it('reserves room for related content while the software keyboard is visible', async () => {
        const view = await render(
            <KeyboardAwareScrollView
                testID="keyboard-scroller"
                keyboardContextHeight={220}
                contentContainerStyle={{ paddingBottom: 24 }}
            >
                <AppText>Form content</AppText>
            </KeyboardAwareScrollView>
        );

        await act(() => {
            const showKeyboard = keyboardListeners.keyboardDidShow ?? keyboardListeners.keyboardWillShow;
            showKeyboard?.();
        });

        const contentStyle = StyleSheet.flatten(
            view.container.queryAll((node) => node.type === 'RCTScrollView')[0].props.contentContainerStyle
        );
        expect(contentStyle.paddingBottom).toBe(220);
    });

    it('preserves larger configured bottom padding when the keyboard opens', async () => {
        const view = await render(
            <KeyboardAwareScrollView
                keyboardContextHeight={120}
                contentContainerStyle={{ paddingBottom: 160 }}
            >
                <AppText>Form content</AppText>
            </KeyboardAwareScrollView>
        );

        await act(() => {
            const showKeyboard = keyboardListeners.keyboardDidShow ?? keyboardListeners.keyboardWillShow;
            showKeyboard?.();
        });

        const contentStyle = StyleSheet.flatten(
            view.container.queryAll((node) => node.type === 'RCTScrollView')[0].props.contentContainerStyle
        );
        expect(contentStyle.paddingBottom).toBe(160);
    });

    it('does not add keyboard padding when the parent already fits above the keyboard', async () => {
        const view = await render(
            <KeyboardAwareScrollView keyboardBounded contentContainerStyle={{ paddingBottom: 12 }}>
                <AppText>Short sheet</AppText>
            </KeyboardAwareScrollView>
        );
        await act(() => (keyboardListeners.keyboardDidShow ?? keyboardListeners.keyboardWillShow)?.());
        const scroller = view.container.queryAll((node) => node.type === 'RCTScrollView')[0];
        expect(StyleSheet.flatten(scroller.props.contentContainerStyle).paddingBottom).toBe(12);
        expect(scroller.props.automaticallyAdjustKeyboardInsets).toBe(false);
    });
});
