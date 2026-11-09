/** @file Reveals focused form inputs in either a keyboard-bounded sheet or a full-screen form. */

import React, { useCallback, useEffect, useRef } from 'react';
import {
    Platform,
    ScrollView,
    StyleSheet,
    TextInput,
    type ScrollViewProps,
    type View
} from 'react-native';
import { useVisualViewportHeight } from '../hooks/useVisualViewportHeight';
import { useSoftwareKeyboardVisible } from '../hooks/useSoftwareKeyboardVisible';

type KeyboardAwareScrollViewProps = ScrollViewProps & {
    keyboardContextHeight?: number;
    keyboardContextRef?: React.RefObject<React.ComponentRef<typeof View> | null>;
    keyboardBounded?: boolean;
    revealFocusedInputOnFocus?: boolean;
};
type FocusedInput = Parameters<React.ComponentRef<typeof ScrollView>['scrollResponderScrollNativeHandleToKeyboard']>[0];

const DEFAULT_KEYBOARD_CONTEXT_HEIGHT = 192; // Keeps validation, actions, or the first search result visible below the active field.
const FOCUSED_FIELD_CLEARANCE = 8; // Leaves a small gap between the field and the scroller's clipped edges.

type FieldGeometry = { getBoundingClientRect: () => { top: number; height: number } };
type ScrollGeometry = FieldGeometry & { scrollTop: number; clientHeight: number };

/** Returns the nearest offset that fits the focused field, including trailing context when there is room for both. */
export function resolveFocusedFieldOffset(
    fieldTop: number,
    fieldHeight: number,
    offset: number,
    viewportHeight: number,
    trailingContext = 0
): number {
    const gap = Math.min(FOCUSED_FIELD_CLEARANCE, Math.max(0, (viewportHeight - fieldHeight) / 2));
    const contextFits = fieldHeight + trailingContext <= viewportHeight - 2 * gap;
    const targetHeight = fieldHeight + (contextFits ? trailingContext : 0);
    if (fieldHeight >= viewportHeight || fieldTop < offset + gap) return Math.max(0, fieldTop - gap);
    return Math.max(offset, fieldTop + targetHeight + gap - viewportHeight);
}

function readFocusedFieldOffset(input: FieldGeometry, viewport: ScrollGeometry, context: FieldGeometry | null | undefined): number {
    const field = input.getBoundingClientRect();
    const top = field.top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    const end = context?.getBoundingClientRect();
    const trailingContext = end ? Math.max(0, end.top + end.height - field.top - field.height) : 0;
    return resolveFocusedFieldOffset(top, field.height, viewport.scrollTop, viewport.clientHeight, trailingContext);
}

/**
 * Reveals the active field when the keyboard opens, focus moves, or the viewport reflows.
 * Keyboard-bounded sheets scroll within their measured body and use no additional keyboard inset.
 */
export const KeyboardAwareScrollView: React.FC<KeyboardAwareScrollViewProps> = ({
    automaticallyAdjustKeyboardInsets,
    contentContainerStyle,
    keyboardBounded = false,
    keyboardContextHeight = DEFAULT_KEYBOARD_CONTEXT_HEIGHT,
    keyboardContextRef,
    keyboardDismissMode = 'on-drag',
    keyboardShouldPersistTaps = 'handled',
    onContentSizeChange,
    onFocus,
    onLayout,
    revealFocusedInputOnFocus = false,
    showsVerticalScrollIndicator = false,
    ...props
}) => {
    const scrollViewRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
    const focusedInputRef = useRef<FocusedInput | null | undefined>(null);
    const revealFrameRef = useRef<number | undefined>(undefined);
    const visualViewportHeight = useVisualViewportHeight();
    const isKeyboardVisible = useSoftwareKeyboardVisible(visualViewportHeight);

    const revealBoundedInput = useCallback(() => {
        const scroller = scrollViewRef.current;
        const nativeViewport = scroller?.getNativeScrollRef();
        if (!scroller || !nativeViewport || nativeViewport.clientHeight <= 0) return;
        const context = isKeyboardVisible ? keyboardContextRef?.current : null;
        if (Platform.OS === 'web') {
            const viewport = nativeViewport as unknown as HTMLElement;
            const input = viewport.ownerDocument.activeElement;
            if (!input?.matches('input, textarea') || !viewport.contains(input)) return;
            const next = readFocusedFieldOffset(input, viewport, context);
            if (Math.abs(next - viewport.scrollTop) >= 1) viewport.scrollTop = next;
            return;
        }

        const input = TextInput.State.currentlyFocusedInput();
        if (!input || !nativeViewport.contains(input)) return;
        const next = readFocusedFieldOffset(input, nativeViewport, context);
        if (Math.abs(next - nativeViewport.scrollTop) >= 1) scroller.scrollTo({ y: next, animated: false });
    }, [isKeyboardVisible, keyboardContextRef]);

    const revealFocusedInput = useCallback((input: FocusedInput | null | undefined = focusedInputRef.current) => {
        if (!keyboardBounded && !input) return;
        if (revealFrameRef.current !== undefined) cancelAnimationFrame(revealFrameRef.current);

        revealFrameRef.current = requestAnimationFrame(() => {
            revealFrameRef.current = undefined;
            if (keyboardBounded) {
                revealBoundedInput();
                return;
            }
            if (!input) return;
            if (
                Platform.OS === 'web'
                && typeof (input as { scrollIntoView?: unknown }).scrollIntoView === 'function'
            ) {
                (input as unknown as Element).scrollIntoView({ block: 'center', inline: 'nearest' });
                return;
            }

            scrollViewRef.current?.scrollResponderScrollNativeHandleToKeyboard(
                input,
                keyboardContextHeight,
                true
            );
        });
    }, [keyboardBounded, keyboardContextHeight, revealBoundedInput]);

    useEffect(() => () => {
        if (revealFrameRef.current !== undefined) cancelAnimationFrame(revealFrameRef.current);
    }, []);

    useEffect(() => {
        if (!isKeyboardVisible) return;
        if (!keyboardBounded && Platform.OS !== 'web') {
            focusedInputRef.current = TextInput.State.currentlyFocusedInput();
        }
        revealFocusedInput();
    }, [isKeyboardVisible, keyboardBounded, revealFocusedInput, visualViewportHeight]);

    const flattenedContentStyle = StyleSheet.flatten(contentContainerStyle);
    const configuredBottomPadding = typeof flattenedContentStyle?.paddingBottom === 'number'
        ? flattenedContentStyle.paddingBottom
        : 0;
    const keyboardContentStyle = isKeyboardVisible && !keyboardBounded
        ? { paddingBottom: Math.max(configuredBottomPadding, keyboardContextHeight) }
        : undefined;

    return (
        <ScrollView
            {...props}
            ref={scrollViewRef}
            automaticallyAdjustKeyboardInsets={
                automaticallyAdjustKeyboardInsets ?? (!keyboardBounded && Platform.OS === 'ios')
            }
            contentContainerStyle={[contentContainerStyle, keyboardContentStyle]}
            keyboardDismissMode={keyboardDismissMode}
            keyboardShouldPersistTaps={keyboardShouldPersistTaps}
            onContentSizeChange={(width, height) => {
                onContentSizeChange?.(width, height);
                if (keyboardBounded || isKeyboardVisible) revealFocusedInput();
            }}
            onFocus={(event) => {
                onFocus?.(event);
                if (!keyboardBounded) focusedInputRef.current = event.target;
                if (keyboardBounded || revealFocusedInputOnFocus || isKeyboardVisible) revealFocusedInput(event.target);
            }}
            onLayout={(event) => {
                onLayout?.(event);
                if (keyboardBounded) revealFocusedInput();
            }}
            showsVerticalScrollIndicator={showsVerticalScrollIndicator}
        />
    );
};
