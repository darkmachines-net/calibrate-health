/** @file use Reduced Motion Preference: Tracks the OS reduce-motion preference for custom native animations. */

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** Tracks the OS reduce-motion preference for custom native animations. */
export function useReducedMotionPreference(): boolean {
    const [isReducedMotionEnabled, setIsReducedMotionEnabled] = useState(false);

    useEffect(() => {
        let active = true;
        void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
            if (active) setIsReducedMotionEnabled(enabled);
        });
        const subscription = AccessibilityInfo.addEventListener(
            'reduceMotionChanged',
            setIsReducedMotionEnabled
        );
        return () => {
            active = false;
            subscription.remove();
        };
    }, []);

    return isReducedMotionEnabled;
}
