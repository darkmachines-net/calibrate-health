/** @file Web Navigation Rail: Renders the browser navigation rail and reports its measured width to the shared shell. */

import React from 'react';
import { router } from 'expo-router';
import { GuardedTabButton } from './GuardedTabButton';
import { canonicalPathForRoute } from './routeRegistry';
import { radius, spacing, useAppTheme } from '../theme';
import { WEB_NAVIGATION_RAIL_WIDTH, type WebNavigationRailProps } from './WebNavigationRail.types';

const PRIMARY_DESTINATIONS = [
    { name: '(today)', routeId: 'today', label: 'Today' },
    { name: '(progress)', routeId: 'progress', label: 'Progress' }
] as const;
// The compact icon pill is decorative; the whole icon/label link remains a large target.
const ICON_SIZE = 24;
const PILL_WIDTH = 56;
const PILL_HEIGHT = 32;
const ITEM_MIN_HEIGHT = 64;

/** Renders the browser navigation rail and reports its measured width to the shared shell. */
export function WebNavigationRail({ state, descriptors, navigation, insets, onWidthChange }: WebNavigationRailProps) {
    const { colors } = useAppTheme();
    const railRef = React.useRef<HTMLElement>(null);
    React.useLayoutEffect(() => {
        const rail = railRef.current;
        if (!rail) return;
        const measure = () => onWidthChange(rail.getBoundingClientRect().width);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(rail);
        return () => observer.disconnect();
    }, [onWidthChange]);

    return (
        <nav ref={railRef} aria-label="Primary navigation" data-testid="web-navigation-rail" style={{
            boxSizing: 'border-box', flexShrink: 0, width: WEB_NAVIGATION_RAIL_WIDTH,
            minWidth: 'max-content', overflowY: 'auto', background: colors.background,
            borderRight: `1px solid ${colors.border}`,
            padding: `${Math.max(insets.top, spacing.sm)}px ${spacing.sm}px ${Math.max(insets.bottom, spacing.sm)}px`
        }}>
            <style>{`
                [data-testid="web-navigation-rail"] a { text-decoration: none; outline-offset: -2px; }
                [data-testid="web-navigation-rail"] a:hover [data-rail-pill] { background: ${colors.surfaceContainerHigh}; }
                [data-testid="web-navigation-rail"] a:active [data-rail-pill] { background: ${colors.outlineVariant}; }
                [data-testid="web-navigation-rail"] a:focus-visible { outline: 2px solid ${colors.primary}; }
                [data-testid="web-navigation-rail"] a[aria-selected="true"] [data-rail-pill] { background: ${colors.selectionContainer}; }
                [data-testid="web-navigation-rail"] a[aria-selected="true"]:hover [data-rail-pill] { box-shadow: inset 0 0 0 2px ${colors.primary}; }
                [data-testid="web-navigation-rail"] a[aria-selected="true"]:active [data-rail-pill] { background: ${colors.outlineVariant}; }
                @media (forced-colors: active) {
                    [data-testid="web-navigation-rail"] a[aria-selected="true"] [data-rail-pill] { outline: 2px solid Highlight; }
                    [data-testid="web-navigation-rail"] a:hover [data-rail-pill] { outline: 2px dashed LinkText; }
                    [data-testid="web-navigation-rail"] a:active [data-rail-pill] { outline: 3px double Highlight; }
                    [data-testid="web-navigation-rail"] a:focus-visible { outline-color: Highlight; }
                }
            `}</style>
            <div role="tablist" aria-label="Main tabs" aria-orientation="vertical" style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
                {PRIMARY_DESTINATIONS.map(({ name, routeId, label }) => {
                    const route = state.routes.find((candidate) => candidate.name === name);
                    if (!route) return null;
                    const focused = state.routes[state.index].key === route.key;
                    const { options } = descriptors[route.key];
                    const color = focused ? colors.onPrimaryContainer : colors.muted;
                    const navigate = () => {
                        const tabEvent = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                        if (!focused && !tabEvent.defaultPrevented) {
                            // Canonical link routing preserves browser history when leaving a retained editor.
                            router.navigate(canonicalPathForRoute(routeId));
                        }
                    };
                    return (
                        <GuardedTabButton
                            key={route.key}
                            href={canonicalPathForRoute(routeId)}
                            role="tab"
                            aria-label={label}
                            aria-selected={focused}
                            onGuardedNavigate={navigate}
                            onPress={(event) => {
                                event.preventDefault();
                                navigate();
                            }}
                            onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
                            style={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: ITEM_MIN_HEIGHT,
                                paddingVertical: spacing.xs, paddingHorizontal: spacing.xs, gap: spacing.xs,
                                borderRadius: radius.md }}
                        >
                            <span aria-hidden="true" data-rail-pill style={{
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                width: PILL_WIDTH, height: PILL_HEIGHT, borderRadius: radius.pill
                            }}>
                                {options.tabBarIcon?.({ focused, color, size: ICON_SIZE })}
                            </span>
                            <span style={{ display: 'block', color, fontSize: 12, lineHeight: '16px', fontWeight: '600', whiteSpace: 'nowrap',
                                textDecoration: focused ? 'underline' : 'none', textUnderlineOffset: spacing.xs }}>
                                {label}
                            </span>
                        </GuardedTabButton>
                    );
                })}
            </div>
        </nav>
    );
}
