/** @file Food Log Dock Actions: Keep one Add food button anchored while the day action slides beyond the right edge. */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';
import { useExpansionMotion } from '../components/PageExpansion';
import { useAppTheme } from '../theme';

type FoodLogDockActionsProps = {
    addFood: React.ReactNode;
    dayAction: React.ReactNode;
    stacked: boolean;
};

/** Keep one Add food button anchored while the day action slides beyond the right edge. */
export function FoodLogDockActions({ addFood, dayAction, stacked }: FoodLogDockActionsProps) {
    const theme = useAppTheme();
    const motion = useExpansionMotion('food');
    const progress = motion?.progress;
    const moving = motion?.moving ?? false;
    const [width, setWidth] = useState(0);
    const [addHeight, setAddHeight] = useState(0);
    const [dayHeight, setDayHeight] = useState(0);
    const dayActionRef = useRef<View>(null);
    const addFoodRef = useRef<View>(null);
    const active = Boolean(progress);
    const gap = theme.spacing.sm;
    const halfWidth = Math.max(0, (width - gap) / 2);
    useLayoutEffect(() => {
        if (Platform.OS !== 'web') return;
        const element = dayActionRef.current as unknown as HTMLElement | null;
        if (element) element.inert = active;
        // Match the pane's interaction lock so completion cannot focus behind a newly opened sheet.
        const addElement = addFoodRef.current as unknown as HTMLElement | null;
        if (addElement) addElement.inert = moving;
    }, [active, moving]);

    // Large text already uses full-width buttons; shrink the vacated second row instead.
    const rowMotion = progress && stacked && addHeight > 0 && dayHeight > 0
        ? { height: progress.interpolate({ inputRange: [0, 1], outputRange: [addHeight + gap + dayHeight, addHeight] }) }
        : undefined;
    const addMotion = progress && !stacked && width > 0
        ? { width: progress.interpolate({ inputRange: [0, 1], outputRange: [halfWidth, width] }) }
        : undefined;
    let dayMotion;
    if (progress && width > 0) {
        dayMotion = stacked
            ? { transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, width + gap] }) }] }
            : { width: halfWidth };
    }

    return <Animated.View
        testID="food-log-dock-actions"
        onLayout={event => setWidth(event.nativeEvent.layout.width)}
        style={[styles.row, { gap }, stacked && styles.stacked, active && styles.clipped, rowMotion]}
    >
        <Animated.View
            ref={addFoodRef}
            pointerEvents={moving ? 'none' : 'auto'}
            aria-hidden={moving}
            accessibilityElementsHidden={moving}
            importantForAccessibility={moving ? 'no-hide-descendants' : 'auto'}
            onLayout={event => setAddHeight(event.nativeEvent.layout.height)}
            style={[styles.action, stacked && styles.stackedAction, addMotion && styles.sizedAction, addMotion]}
        >{addFood}</Animated.View>
        <Animated.View
            ref={dayActionRef}
            onLayout={event => setDayHeight(event.nativeEvent.layout.height)}
            pointerEvents={active ? 'none' : 'auto'}
            aria-hidden={active}
            accessibilityElementsHidden={active}
            importantForAccessibility={active ? 'no-hide-descendants' : 'auto'}
            style={[styles.action, stacked && styles.stackedAction, dayMotion && styles.sizedAction, dayMotion]}
        >{dayAction}</Animated.View>
    </Animated.View>;
}

const styles = StyleSheet.create({
    row: { width: '100%', flexDirection: 'row', alignItems: 'stretch' },
    stacked: { flexDirection: 'column' },
    clipped: { overflow: 'hidden' },
    // Explicit flex properties let native Yoga honor animated widths and stacked heights.
    action: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
    sizedAction: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
    stackedAction: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', width: '100%' }
});
