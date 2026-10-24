/** @file Viewport and text-scale policies for compact, tablet, and adaptive form composition. */

import type { ModalProps } from 'react-native';

// Activates two-column content and bounded dialogs for iPad and Android tablet widths.
export const TABLET_LAYOUT_BREAKPOINT = 720;
// Moves primary navigation to a rail when a tablet has enough landscape width.
export const NAVIGATION_RAIL_BREAKPOINT = 1024;
export const LARGE_TEXT_COMPACT_LAYOUT_SCALE = 1.6;

export const SUPPORTED_MODAL_ORIENTATIONS: NonNullable<ModalProps['supportedOrientations']> = [
    'portrait',
    'portrait-upside-down',
    'landscape',
    'landscape-left',
    'landscape-right'
];

/** Enables tablet composition only when viewport width and text scale leave sufficient space. */
export function usesTabletLayout(width: number, fontScale = 1): boolean {
    return width >= TABLET_LAYOUT_BREAKPOINT && fontScale < LARGE_TEXT_COMPACT_LAYOUT_SCALE;
}

/** Keeps horizontal padding at least the base gutter and outside either safe-area inset. */
export function resolveSafeHorizontalPadding(
    basePadding: number,
    leftInset: number,
    rightInset: number,
    insetGap: number
): { paddingLeft: number; paddingRight: number } {
    return {
        paddingLeft: Math.max(basePadding, leftInset + insetGap),
        paddingRight: Math.max(basePadding, rightInset + insetGap)
    };
}
