/** @file Keyboard Aware Scroll View: Shared form scroller that reveals focused inputs plus the content that explains or acts on their current value. */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Keyboard,
    Platform,
    ScrollView,
    StyleSheet,
    TextInput,
    type ScrollViewProps
} from 'react-native';
import { useVisualViewportHeight } from '../hooks/useVisualViewportHeight';

type KeyboardAwareScrollViewProps = ScrollViewProps & {
    keyboardContextHeight?: number;
    revealFocusedInputOnFocus?: boolean;
};

const DEFAULT_KEYBOARD_CONTEXT_HEIGHT = 192; // Keeps validation, actions, or the first search result visible below the active field.
const WEB_KEYBOARD_OVERLAY_THRESHOLD = 80; // Ignores small visual-viewport changes caused by mobile browser chrome.

/**
 * Shared form scroller that reveals focused inputs plus the content that
 * explains or acts on their current value.
 */
export const KeyboardAwareScrollView: React.FC<KeyboardAwareScrollViewProps> = ({
    automaticallyAdjustKeyboardInsets,
    contentContainerStyle,
    keyboardContextHeight = DEFAULT_KEYBOARD_CONTEXT_HEIGHT,
    keyboardDismissMode = 'on-drag',
    keyboardShouldPersistTaps = 'handled',
    onContentSizeChange,
    onFocus,
    revealFocusedInputOnFocus = false,
    showsVerticalScrollIndicator = false,
    ...props
}) => {
    const scrollViewRef = useRef<ScrollView>(null);
    const focusedInputRef = useRef<unknown>(null);
    const [isKeyboardVisible, setIsKeyboardVisible] = useState(() => Platform.OS !== 'web' && Keyboard.isVisible());
    const visualViewportHeight = useVisualViewportHeight();
    const isWebKeyboardOverlayVisible = Platform.OS === 'web'
        && visualViewportHeight !== undefined
        && typeof window !== 'undefined'
        && visualViewportHeight < window.innerHeight - WEB_KEYBOARD_OVERLAY_THRESHOLD;
    const shouldRevealKeyboardContext = isKeyboardVisible || isWebKeyboardOverlayVisible;

    const revealFocusedInput = useCallback((input: unknown = focusedInputRef.current) => {
        if (!input) return;

        requestAnimationFrame(() => {
            if (
                Platform.OS === 'web'
                && typeof (input as { scrollIntoView?: unknown }).scrollIntoView === 'function'
            ) {
                (input as Element).scrollIntoView({ block: 'center', inline: 'nearest' });
                return;
            }

            scrollViewRef.current?.scrollResponderScrollNativeHandleToKeyboard(
                input,
                keyboardContextHeight,
                true
            );
        });
    }, [keyboardContextHeight]);

    useEffect(() => {
        if (Platform.OS === 'web') return;

        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
        const showSubscription = Keyboard.addListener(showEvent, () => {
            setIsKeyboardVisible(true);
            const focusedInput = TextInput.State.currentlyFocusedInput();
            focusedInputRef.current = focusedInput;
            revealFocusedInput(focusedInput);
        });
        const hideSubscription = Keyboard.addListener(hideEvent, () => setIsKeyboardVisible(false));

        return () => {
            showSubscription.remove();
            hideSubscription.remove();
        };
    }, [revealFocusedInput]);

    const flattenedContentStyle = StyleSheet.flatten(contentContainerStyle);
    const configuredBottomPadding = typeof flattenedContentStyle?.paddingBottom === 'number'
        ? flattenedContentStyle.paddingBottom
        : 0;
    const keyboardContentStyle = shouldRevealKeyboardContext
        ? { paddingBottom: Math.max(configuredBottomPadding, keyboardContextHeight) }
        : undefined;

    useEffect(() => {
        if (isWebKeyboardOverlayVisible) revealFocusedInput();
    }, [isWebKeyboardOverlayVisible, revealFocusedInput]);

    return (
        <ScrollView
            {...props}
            ref={scrollViewRef}
            automaticallyAdjustKeyboardInsets={
                automaticallyAdjustKeyboardInsets ?? Platform.OS === 'ios'
            }
            contentContainerStyle={[contentContainerStyle, keyboardContentStyle]}
            keyboardDismissMode={keyboardDismissMode}
            keyboardShouldPersistTaps={keyboardShouldPersistTaps}
            onContentSizeChange={(width, height) => {
                onContentSizeChange?.(width, height);
                if (shouldRevealKeyboardContext) revealFocusedInput();
            }}
            onFocus={(event) => {
                onFocus?.(event);
                focusedInputRef.current = event.target;
                if (revealFocusedInputOnFocus || shouldRevealKeyboardContext) revealFocusedInput(event.target);
            }}
            showsVerticalScrollIndicator={showsVerticalScrollIndicator}
        />
    );
};
