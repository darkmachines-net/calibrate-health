/** @file Tracks software keyboard visibility without treating hardware keyboard focus as an overlay. */

import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

const WEB_KEYBOARD_OVERLAY_THRESHOLD = 80; // Filters out changes caused by browser chrome.

/** Tracks native keyboard events or, on web, an unzoomed visual viewport reduced by the keyboard. */
export function useSoftwareKeyboardVisible(visualViewportHeight: number | undefined): boolean {
    const [nativeVisible, setNativeVisible] = useState(() => Platform.OS !== 'web' && Keyboard.isVisible());

    useEffect(() => {
        if (Platform.OS === 'web') return;
        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
        const show = Keyboard.addListener(showEvent, () => setNativeVisible(true));
        const hide = Keyboard.addListener(hideEvent, () => setNativeVisible(false));
        // A field mounted mid-transition may have missed the iOS will-show notification.
        const didShow = Platform.OS === 'ios' ? Keyboard.addListener('keyboardDidShow', () => setNativeVisible(true)) : undefined;
        return () => {
            show.remove();
            hide.remove();
            didShow?.remove();
        };
    }, []);

    if (Platform.OS !== 'web') return nativeVisible;
    return visualViewportHeight !== undefined
        && typeof window !== 'undefined'
        && (window.visualViewport?.scale ?? 1) === 1
        && visualViewportHeight < window.innerHeight - WEB_KEYBOARD_OVERLAY_THRESHOLD;
}
