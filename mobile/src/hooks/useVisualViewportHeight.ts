/** @file Native counterpart of the browser viewport measurements. */

/** Native layouts receive keyboard dimensions from React Native. */
export function useVisualViewportHeight(): number | undefined {
    return undefined;
}

/** Native modals use their own window coordinates without a browser viewport offset. */
export function useVisualViewportOffsetTop(): number {
    return 0;
}
