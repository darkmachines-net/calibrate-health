/** @file Web Navigation Rail: Leaves native navigation to the standard tab bar by rendering no web rail. */

import type { WebNavigationRailProps } from './WebNavigationRail.types';

// Native phone/tablet navigation continues to use the standard tab bar.
/** Leaves native navigation to the standard tab bar by rendering no web rail. */
export function WebNavigationRail(_props: WebNavigationRailProps) {
    return null;
}
