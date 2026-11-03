/** @file Native viewport-hook fallbacks leave keyboard geometry to React Native's layout handling. */

/** Native layouts receive keyboard dimensions from React Native. */
export function useVisualViewportHeight(): number | undefined {
    return undefined;
}

/** Native modal positioning is handled by KeyboardAvoidingView rather than browser viewport offsets. */
export function useVisualViewportOffsetTop(): number | undefined {
    return undefined;
}
