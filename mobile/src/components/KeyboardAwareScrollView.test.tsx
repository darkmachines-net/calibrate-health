/** @file Regression coverage for Keyboard Aware Scroll View: KeyboardAwareScrollView. */

import { Keyboard, ScrollView, StyleSheet } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { AppText } from './AppText';
import { KeyboardAwareScrollView } from './KeyboardAwareScrollView';

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

    it('uses form-friendly keyboard interaction defaults', () => {
        const view = render(
            <KeyboardAwareScrollView testID="keyboard-scroller">
                <AppText>Form content</AppText>
            </KeyboardAwareScrollView>
        );

        const scroller = view.UNSAFE_getByType(ScrollView);
        expect(scroller.props.keyboardDismissMode).toBe('on-drag');
        expect(scroller.props.keyboardShouldPersistTaps).toBe('handled');
        expect(scroller.props.showsVerticalScrollIndicator).toBe(false);
    });

    it('does not move the viewport merely because an input receives focus', () => {
        const animationFrame = jest.spyOn(global, 'requestAnimationFrame').mockImplementation(() => 1);
        const view = render(
            <KeyboardAwareScrollView>
                <AppText>Form content</AppText>
            </KeyboardAwareScrollView>
        );

        act(() => {
            view.UNSAFE_getByType(ScrollView).props.onFocus({ target: {} });
        });

        expect(animationFrame).not.toHaveBeenCalled();
    });

    it('can reveal a focused field immediately for keyboard-first editors', () => {
        const animationFrame = jest.spyOn(global, 'requestAnimationFrame').mockImplementation(() => 1);
        const view = render(
            <KeyboardAwareScrollView revealFocusedInputOnFocus>
                <AppText>Form content</AppText>
            </KeyboardAwareScrollView>
        );

        act(() => {
            view.UNSAFE_getByType(ScrollView).props.onFocus({ target: {} });
        });

        expect(animationFrame).toHaveBeenCalledTimes(1);
    });

    it('reserves room for related content while the software keyboard is visible', () => {
        const view = render(
            <KeyboardAwareScrollView
                testID="keyboard-scroller"
                keyboardContextHeight={220}
                contentContainerStyle={{ paddingBottom: 24 }}
            >
                <AppText>Form content</AppText>
            </KeyboardAwareScrollView>
        );

        act(() => {
            const showKeyboard = keyboardListeners.keyboardDidShow ?? keyboardListeners.keyboardWillShow;
            showKeyboard?.();
        });

        const contentStyle = StyleSheet.flatten(
            view.UNSAFE_getByType(ScrollView).props.contentContainerStyle
        );
        expect(contentStyle.paddingBottom).toBe(220);
    });

    it('preserves larger configured bottom padding when the keyboard opens', () => {
        const view = render(
            <KeyboardAwareScrollView
                keyboardContextHeight={120}
                contentContainerStyle={{ paddingBottom: 160 }}
            >
                <AppText>Form content</AppText>
            </KeyboardAwareScrollView>
        );

        act(() => {
            const showKeyboard = keyboardListeners.keyboardDidShow ?? keyboardListeners.keyboardWillShow;
            showKeyboard?.();
        });

        const contentStyle = StyleSheet.flatten(
            view.UNSAFE_getByType(ScrollView).props.contentContainerStyle
        );
        expect(contentStyle.paddingBottom).toBe(160);
    });
});
