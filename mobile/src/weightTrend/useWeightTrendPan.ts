/** @file Native horizontal chart drag recognition; vertical gestures remain with the screen scroll view. */

import { useLayoutEffect, useMemo, useRef } from 'react';
import { PanResponder, type GestureResponderHandlers, type View } from 'react-native';
import type { ComponentRef, Ref } from 'react';

// Distinguishes a drag from the small motion of a tap.
const WEIGHT_TREND_DRAG_THRESHOLD = 6;

export type WeightTrendPanCallbacks = {
    begin: () => void;
    move: (pixels: number) => void;
    end: () => void;
};

export type WeightTrendPanBindings = {
    ref?: Ref<ComponentRef<typeof View>>;
    panHandlers?: GestureResponderHandlers;
};

/** Claims horizontal movement after the tap threshold and reports displacement until release. */
export function useWeightTrendPan(callbacks: WeightTrendPanCallbacks): WeightTrendPanBindings {
    const handlers = useRef(callbacks);
    useLayoutEffect(() => { handlers.current = callbacks; }, [callbacks]);
    return useMemo(() => PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_, gesture) =>
            Math.abs(gesture.dx) >= WEIGHT_TREND_DRAG_THRESHOLD && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderGrant: () => handlers.current.begin(),
        onPanResponderMove: (_, gesture) => handlers.current.move(gesture.dx),
        onPanResponderRelease: () => handlers.current.end(),
        onPanResponderTerminate: () => handlers.current.end()
    }), []);
}
