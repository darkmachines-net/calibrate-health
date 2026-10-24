/** @file Native counterpart of browser safe-area styles; native surfaces own their measured insets. */

import type { ViewStyle } from 'react-native';

/** Returns no overrides on native; minimum browser spacing does not affect native inset calculations. */
export function webSafeAreaPadding(_minimum = 0): ViewStyle {
    return {};
}
