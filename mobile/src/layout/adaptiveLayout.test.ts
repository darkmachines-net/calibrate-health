/** @file Regression coverage for adaptive Layout: adaptive layout. */

import {
    LARGE_TEXT_COMPACT_LAYOUT_SCALE,
    NAVIGATION_RAIL_BREAKPOINT,
    SUPPORTED_MODAL_ORIENTATIONS,
    TABLET_LAYOUT_BREAKPOINT,
    resolveSafeHorizontalPadding,
    usesTabletLayout
} from './adaptiveLayout';

describe('adaptive layout', () => {
    it('activates tablet content before the navigation rail', () => {
        expect(usesTabletLayout(TABLET_LAYOUT_BREAKPOINT - 1)).toBe(false);
        expect(usesTabletLayout(TABLET_LAYOUT_BREAKPOINT)).toBe(true);
        expect(NAVIGATION_RAIL_BREAKPOINT).toBeGreaterThan(TABLET_LAYOUT_BREAKPOINT);
    });

    it('preserves compact layouts for large text', () => {
        expect(usesTabletLayout(TABLET_LAYOUT_BREAKPOINT, LARGE_TEXT_COMPACT_LAYOUT_SCALE)).toBe(false);
    });

    it('keeps horizontal content beyond asymmetric display cutouts', () => {
        expect(resolveSafeHorizontalPadding(24, 44, 0, 8)).toEqual({
            paddingLeft: 52,
            paddingRight: 24
        });
    });

    it('allows native modals to stay open across phone and tablet rotation', () => {
        expect(SUPPORTED_MODAL_ORIENTATIONS).toEqual(expect.arrayContaining([
            'portrait',
            'portrait-upside-down',
            'landscape-left',
            'landscape-right'
        ]));
    });
});
