import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, BackHandler, Easing, findNodeHandle, Platform, Pressable, StyleSheet, View, type ViewProps } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useReducedMotionPreference } from '../hooks/useReducedMotionPreference';
import { useExpansionHistory } from '../hooks/useExpansionHistory';
import { interaction, radius, spacing, useAppTheme } from '../theme';
import { AppText } from './AppText';
import { useFocusVisible } from './useFocusVisible';

// The pane edges and displaced sections share one clock, without scaling text or charts.
const PAGE_EXPAND_DURATION = 400;
const PAGE_COLLAPSE_DURATION = 360;
const DETAIL_REVEAL_END = 0.65; // Crossfade source and detail together so the growing pane never blanks the source.
const BACK_ICON_SIZE = 20; // Keeps the return arrow aligned with the header's label text.

type Region = { ref: React.RefObject<View | null>; order: number };
type Bounds = { top: number; height: number };
type Transition = Bounds & { id: string; order: number };
export type PageExpansionConfig = {
    id: string | null;
    title: string;
    backLabel: string;
    onClose: () => void;
    onRestore: (id: string) => void;
    renderContent: (id: string) => React.ReactNode;
    focused?: boolean;
};
type ExpansionContextValue = {
    register: (id: string, region: Region) => () => void;
    transition: Transition | null;
    progress: Animated.Value;
    height: number;
    moving: boolean;
};
const ExpansionContext = React.createContext<ExpansionContextValue | null>(null);

/** Let persistent controls follow the selected pane's expansion and collapse clock. */
export function useExpansionMotion(id: string) {
    const context = React.useContext(ExpansionContext);
    return context?.transition?.id === id ? { progress: context.progress, moving: context.moving } : null;
}

/** A measured overview region stays mounted while its siblings move out of the pane. */
export function ExpansionRegion({ id, order, style, ...props }: ViewProps & { id?: string; order: number }) {
    const context = React.useContext(ExpansionContext);
    const ref = useRef<View>(null);
    const register = context?.register;
    useEffect(() => id ? register?.(id, { ref, order }) : undefined, [id, order, register]);
    const transition = context?.transition;
    const progress = context?.progress;
    const height = context?.height;
    const motion = useMemo(() => {
        if (!progress || !transition || !id || height === undefined) return undefined;
        let travel = -transition.top;
        if (order > transition.order) travel = height - transition.top - transition.height;
        return {
            transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, travel] }) }],
            opacity: id === transition.id
                ? progress.interpolate({ inputRange: [0, DETAIL_REVEAL_END, 1], outputRange: [1, 0, 0] })
                : 1
        } as ViewProps['style'];
    }, [height, id, order, progress, transition]);
    return <Animated.View {...props} ref={ref} collapsable={false} style={[style, motion]} />;
}

type PageExpansionProps = {
    config?: PageExpansionConfig;
    columnStyle: ViewProps['style'];
    children: (blocked: boolean) => React.ReactNode;
    footer?: React.ReactNode;
};

/** Expands inside the available shell viewport; this is page content, not a modal. */
export function PageExpansion({ config, columnStyle, children, footer }: PageExpansionProps) {
    const theme = useAppTheme();
    const reducedMotion = useReducedMotionPreference();
    const viewport = useRef<View>(null);
    const overview = useRef<View>(null);
    const backControl = useRef<View>(null);
    const regions = useRef(new Map<string, Region>());
    const progress = useRef(new Animated.Value(0)).current;
    const [height, setHeight] = useState(0);
    const [transition, setTransition] = useState<Transition | null>(null);
    const transitionRef = useRef(transition);
    transitionRef.current = transition;
    const [{ title, backLabel }, setHeading] = useState({ title: '', backLabel: '' });
    const [backHovered, setBackHovered] = useState(false);
    const [moving, setMoving] = useState(false);
    const returnFocus = useRef<HTMLElement | null>(null);
    const returnRegion = useRef<string | null>(null);
    const restoreFocusPending = useRef(false);
    const generation = useRef(0);
    const configRef = useRef(config);
    configRef.current = config;
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();
    const register = useCallback((id: string, region: Region) => {
        regions.current.set(id, region);
        return () => { regions.current.delete(id); };
    }, []);
    const id = config?.id;
    const requestClose = useCallback(() => {
        const current = transitionRef.current;
        const source = current && regions.current.get(current.id);
        if (!current || !source?.ref.current || !viewport.current) { configRef.current?.onClose(); return; }
        if (configRef.current?.id !== current.id) return;
        // Read the current value directly: native node detachment clears listeners between cycles.
        // Pause while measuring so an interrupted expansion cannot move beneath the measurement.
        progress.stopAnimation(currentProgress => {
            viewport.current?.measureInWindow((_x, viewportY) => {
                const sourceView = source.ref.current;
                if (!sourceView) { configRef.current?.onClose(); return; }
                sourceView.measureInWindow((_sourceX, sourceY, _width, sourceHeight) => {
                    if (configRef.current?.id !== current.id) return;
                    const top = sourceY - viewportY + current.top * currentProgress;
                    // Reuse the opening geometry unless the resting layout actually changed.
                    if (top !== current.top || sourceHeight !== current.height) {
                        setTransition({ ...current, top, height: sourceHeight });
                    }
                    configRef.current.onClose();
                });
            });
        });
    }, [progress]);
    useExpansionHistory(id, config?.focused !== false, requestClose, restored => configRef.current?.onRestore(restored));

    useEffect(() => {
        if (!id) return;
        if (transitionRef.current?.id === id) return;
        const token = ++generation.current;
        const source = regions.current.get(id);
        if (!source || !viewport.current) return;
        setHeading({ title: configRef.current?.title ?? '', backLabel: configRef.current?.backLabel ?? '' });
        setBackHovered(false);
        returnRegion.current = id;
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
            const sourceElement = source.ref.current as unknown as HTMLElement | null;
            returnFocus.current = sourceElement?.querySelector<HTMLElement>('[role="button"],button') ?? null;
        }
        viewport.current.measureInWindow((_x, viewportY, _width, viewportHeight) => {
            source.ref.current?.measureInWindow((_sourceX, sourceY, _sourceWidth, sourceHeight) => {
                if (token !== generation.current || !viewportHeight) return;
                progress.setValue(0);
                setTransition({ id, order: source.order, top: sourceY - viewportY, height: sourceHeight });
                setHeight(viewportHeight);
                setMoving(true);
            });
        });
        return () => { generation.current += 1; };
    }, [id, progress]);

    useEffect(() => {
        if (!transition) return;
        const opening = id === transition.id;
        const duration = opening ? PAGE_EXPAND_DURATION : PAGE_COLLAPSE_DURATION;
        setMoving(true);
        const animation = Animated.timing(progress, {
            toValue: opening ? 1 : 0,
            duration: reducedMotion ? 0 : duration,
            easing: Easing.inOut(Easing.cubic),
            useNativeDriver: false
        });
        const start = () => animation.start(({ finished }) => {
            if (!finished) return;
            setMoving(false);
            if (!opening) {
                restoreFocusPending.current = true;
                setTransition(null);
            } else if (configRef.current?.focused === false) {
                return;
            } else if (Platform.OS === 'web') {
                (backControl.current as unknown as HTMLElement | null)?.focus({ preventScroll: true });
            } else {
                const handle = findNodeHandle(backControl.current);
                if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
            }
        });
        // Commit the moving state and measured return bounds before native frames begin.
        // Keep reduced motion immediate.
        const frame = reducedMotion ? undefined : requestAnimationFrame(start);
        if (reducedMotion) start();
        return () => {
            if (frame !== undefined) cancelAnimationFrame(frame);
            animation.stop();
        };
    }, [id, progress, reducedMotion, transition]);

    useLayoutEffect(() => {
        if (Platform.OS !== 'web') return;
        const element = overview.current as unknown as HTMLElement | null;
        if (element) element.inert = Boolean(transition);
        // Focus must wait for React to expose the overview and remove inert in this same commit.
        if (!transition && restoreFocusPending.current) {
            restoreFocusPending.current = false;
            if (configRef.current?.focused === false) return;
            const source = regions.current.get(returnRegion.current ?? '')?.ref.current as unknown as HTMLElement | null;
            const target = returnFocus.current?.isConnected
                ? returnFocus.current
                : source?.querySelector<HTMLElement>('[role="button"],button');
            target?.focus({ preventScroll: true });
        }
    }, [transition]);

    useEffect(() => {
        if (!id || config?.focused === false) return;
        if (Platform.OS !== 'web') {
            const listener = BackHandler.addEventListener('hardwareBackPress', () => {
                requestClose();
                return true;
            });
            return () => listener.remove();
        }
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            // Nested editors, calendars and confirmation dialogs own their own dismissal first.
            if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) return;
            event.preventDefault();
            requestClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [id, config?.focused, requestClose]);

    const context = useMemo(() => ({ register, transition, progress, height, moving }), [register, transition, progress, height, moving]);
    // Keep the animated nodes attached while focus and moving state update.
    const paneStyle = useMemo(() => transition && {
        top: progress.interpolate({ inputRange: [0, 1], outputRange: [transition.top, 0] }),
        height: progress.interpolate({ inputRange: [0, 1], outputRange: [transition.height, height] }),
        opacity: progress.interpolate({ inputRange: [0, DETAIL_REVEAL_END, 1], outputRange: [0, 1, 1] }),
        backgroundColor: theme.colors.background
    }, [height, progress, theme.colors.background, transition]);

    return <ExpansionContext.Provider value={context}>
        <View ref={viewport} collapsable={false} testID="page-expansion-viewport" style={styles.viewport} onLayout={event => setHeight(event.nativeEvent.layout.height)}>
            <View ref={overview} style={styles.overview} pointerEvents={transition ? 'none' : 'auto'} aria-hidden={Boolean(transition)} accessibilityElementsHidden={Boolean(transition)} importantForAccessibility={transition ? 'no-hide-descendants' : 'auto'}>
                {children(Boolean(transition))}
            </View>
            {transition && <Animated.View testID={`expanded-${transition.id}`} style={[styles.pane, paneStyle]}>
                <View style={[columnStyle, styles.heading]}>
                    <Pressable
                        ref={backControl}
                        accessibilityRole="button"
                        accessibilityLabel={backLabel}
                        onPress={requestClose}
                        onFocus={handleFocus}
                        onBlur={handleBlur}
                        onHoverIn={() => setBackHovered(true)}
                        onHoverOut={() => setBackHovered(false)}
                        style={({ pressed }) => [
                            styles.back,
                            backHovered && { backgroundColor: theme.colors.surfaceHovered },
                            pressed && { backgroundColor: theme.colors.surfacePressed },
                            focusVisible && { outlineWidth: theme.interaction.focusRingWidth, outlineColor: theme.colors.focusRing, outlineStyle: 'solid' }
                        ]}
                    >
                        <Ionicons name="arrow-back" size={BACK_ICON_SIZE} color={theme.colors.primary} accessible={false} aria-hidden />
                        <AppText variant="label" style={[styles.backLabel, { color: theme.colors.primary }]}>{backLabel}</AppText>
                    </Pressable>
                    <AppText variant="section" accessibilityRole="header">{title}</AppText>
                </View>
                <View style={styles.detail} pointerEvents={moving ? 'none' : 'auto'}>
                    {config?.renderContent(transition.id)}
                </View>
            </Animated.View>}
        </View>
        {footer}
    </ExpansionContext.Provider>;
}

const styles = StyleSheet.create({
    viewport: { flex: 1, minHeight: 0, overflow: 'hidden' },
    overview: { flex: 1, minHeight: 0 },
    pane: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
    heading: { paddingTop: spacing.xs, paddingBottom: spacing.sm, flexShrink: 0 },
    back: {
        minHeight: interaction.minimumTouchTarget, maxWidth: '100%', alignSelf: 'flex-start',
        flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radius.sm,
        marginLeft: -spacing.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm
    },
    backLabel: { flexShrink: 1 },
    detail: { flex: 1, minHeight: 0 }
});
