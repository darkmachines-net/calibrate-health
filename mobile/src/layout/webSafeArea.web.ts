/** @file Browser safe-area styles for the app shell and portaled surfaces; Router 58 exposes zero JS insets. */

import type { ViewStyle } from 'react-native';

/** Returns CSS padding that honors each device inset and the requested minimum spacing in pixels. */
export function webSafeAreaPadding(minimum = 0): ViewStyle {
    return {
        paddingTop: `max(${minimum}px, env(safe-area-inset-top, 0px))`,
        paddingBottom: `max(${minimum}px, env(safe-area-inset-bottom, 0px))`,
        paddingLeft: `max(${minimum}px, env(safe-area-inset-left, 0px))`,
        paddingRight: `max(${minimum}px, env(safe-area-inset-right, 0px))`
    } as ViewStyle;
}
