/** @file Regression coverage for adaptive Layout: adaptive layout. */

import {
    NAVIGATION_RAIL_BREAKPOINT,
    SUPPORTED_MODAL_ORIENTATIONS,
    TABLET_LAYOUT_BREAKPOINT,
    resolveSafeHorizontalPadding
} from './adaptiveLayout';

describe('adaptive layout', () => {
    it('activates tablet content before the navigation rail', () => {
        expect(NAVIGATION_RAIL_BREAKPOINT).toBeGreaterThan(TABLET_LAYOUT_BREAKPOINT);
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
