/** @file use System Color Scheme: Subscribes to browser color-scheme changes through a hydration-safe external store. */

import { useSyncExternalStore } from 'react';
import { Appearance, type ColorSchemeName } from 'react-native';

function subscribe(onStoreChange: () => void): () => void {
    const subscription = Appearance.addChangeListener(onStoreChange);
    return () => subscription.remove();
}

function getServerSnapshot(): ColorSchemeName {
    // Match exported HTML during hydration, then update every themed surface to the browser preference.
    return 'light';
}

function getSnapshot(): ColorSchemeName {
    return Appearance.getColorScheme() ?? 'light';
}

/** Subscribes to browser color-scheme changes through a hydration-safe external store. */
export function useSystemColorScheme(): ColorSchemeName {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
