/** @file Guarded Tab Button: Preserve Expo's canonical tab links while guarding retained-editor departures. */

import { Platform, Pressable } from 'react-native';
import { Link, router, type Href } from 'expo-router';
import type { BottomTabBarButtonProps } from 'expo-router/js-tabs';
import { interceptGuardedNavigation } from './guardedNavigation';

/** Preserve Expo's canonical tab links while guarding retained-editor departures. */
export function GuardedTabButton({ href, children, style, onPress, onGuardedNavigate, ref, ...props }:
    Omit<BottomTabBarButtonProps, 'href'> & { href: Href; onGuardedNavigate?: () => void }) {
    // Expo's tab props use Pressable types; Link forwards them to its platform host.
    const linkProps = props as React.ComponentProps<typeof Link>;
    return (
        <Link
            {...linkProps}
            ref={ref as React.ComponentProps<typeof Link>['ref']}
            href={href}
            asChild={Platform.OS !== 'web'}
            style={[{ display: 'flex' }, style as React.ComponentProps<typeof Link>['style']]}
            onPress={(event) => {
                if (event.defaultPrevented) return;
                if (Platform.OS === 'web' && 'button' in event
                    && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
                        || (event.button != null && event.button !== 0)
                        || ![undefined, null, '', 'self'].includes(event.currentTarget.target))) return;
                // Custom navigators can replay their cancellable tab event after confirmation.
                if (interceptGuardedNavigation(onGuardedNavigate ?? (() => router.navigate(href)), () => event.preventDefault())) return;
                onPress?.(event);
            }}
        >
            {Platform.OS === 'web' ? children : <Pressable>{children}</Pressable>}
        </Link>
    );
}
