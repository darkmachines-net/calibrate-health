/** @file Responsive browser navigation rail dimensions and shared component props. */

import type { BottomTabBarProps } from 'expo-router/js-tabs';

// Fits a full Progress label beneath the icon, with compact side gutters.
export const WEB_NAVIGATION_RAIL_WIDTH = 88;

export type WebNavigationRailProps = BottomTabBarProps & {
    /** Report the rendered rail width so adjacent content can reserve space. */
    onWidthChange: (width: number) => void;
};
