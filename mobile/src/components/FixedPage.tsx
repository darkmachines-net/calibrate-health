/** @file Fixed Page: Constrain copy inside an edge-to-edge interaction surface without shrinking its hit target. */

import React from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent, type StyleProp, type ViewStyle, type ViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { resolveSafeHorizontalPadding } from '../layout/adaptiveLayout';
import { useAppTheme } from '../theme';
import { SCREEN_CONTENT_WIDTHS, SCREEN_WIDE_LAYOUT_BREAKPOINT } from './Screen';
import { ExpansionRegion, PageExpansion, type PageExpansionConfig } from './PageExpansion';

const LARGE_TEXT_SCALE = 1.6; // Intrinsic layout keeps enlarged labels and actions fully reachable.
const SHORT_PROGRESS_HEIGHT = 520; // Below this remaining shell height, a complete chart needs page scrolling.
const TEXT_PROBE_SIZE = 16; // Measures browser text enlargement, which does not update native fontScale.

type FixedPageLayout = { expanded: boolean; enlargedText: boolean };
const ColumnStyleContext = React.createContext<StyleProp<ViewStyle>>(undefined);

/** Constrain copy inside an edge-to-edge interaction surface without shrinking its hit target. */
export function FixedPageColumn({ style, ...props }: ViewProps) {
    return <View {...props} style={[styles.column, React.useContext(ColumnStyleContext), style]} />;
}
type FixedPageProps = {
    header?: React.ReactNode;
    context?: React.ReactNode;
    children: React.ReactNode | ((layout: FixedPageLayout) => React.ReactNode);
    footer?: React.ReactNode | ((layout: FixedPageLayout) => React.ReactNode);
    scrollWhenShort?: boolean;
    containedBody?: boolean;
    minBodyHeight?: number;
    contentWidth?: 'overview' | 'wide';
    fullWidthBody?: boolean;
    fullWidthFooter?: boolean;
    testID?: string;
    expansion?: PageExpansionConfig;
    bodyExpansionId?: string;
    footerExpansionId?: string;
    persistentFooter?: boolean;
};

/** A full-page composition within the measured app shell; tabs already own the bottom inset. */
export function FixedPage({ header, context, children, footer, scrollWhenShort = false, containedBody = false, minBodyHeight = 120, contentWidth = 'overview', fullWidthBody = false, fullWidthFooter = false, testID, expansion, bodyExpansionId, footerExpansionId = 'page-footer', persistentFooter = false }: FixedPageProps) {
    const theme = useAppTheme();
    const insets = useSafeAreaInsets();
    const { width, fontScale } = useWindowDimensions();
    const [height, setHeight] = React.useState(0);
    const [headerHeight, setHeaderHeight] = React.useState(0);
    const [scrollHeight, setScrollHeight] = React.useState(0);
    const [contextHeight, setContextHeight] = React.useState(0);
    const [footerHeight, setFooterHeight] = React.useState(0);
    const [webTextScale, setWebTextScale] = React.useState(1);
    const probe = React.useRef<React.ComponentRef<typeof Text>>(null);
    const readTextScale = React.useCallback(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const element = probe.current as unknown as HTMLElement | null;
        if (element) setWebTextScale(Number.parseFloat(window.getComputedStyle(element).fontSize) / TEXT_PROBE_SIZE);
    }, []);
    React.useLayoutEffect(readTextScale, [readTextScale, width]);
    const enlargedText = Math.max(fontScale, webTextScale) >= LARGE_TEXT_SCALE;
    // Scroll when the measured context, complete middle section, and footer cannot fit.
    const cannotContainBody = (containedBody || scrollWhenShort) && height > 0
        && contextHeight + minBodyHeight + footerHeight > height - headerHeight;
    const expanded = enlargedText || cannotContainBody
        || (scrollWhenShort && height > 0 && height - headerHeight < SHORT_PROGRESS_HEIGHT);
    const layout = { expanded, enlargedText };
    const horizontalPadding = resolveSafeHorizontalPadding(
        width >= SCREEN_WIDE_LAYOUT_BREAKPOINT ? theme.spacing.xl : theme.spacing.lg,
        insets.left, insets.right, theme.spacing.sm
    );
    const columnStyle = [styles.column, { maxWidth: SCREEN_CONTENT_WIDTHS[contentWidth] }, horizontalPadding];
    const updateHeight = (event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height);
    const naturalHeight = contextHeight + minBodyHeight;
    const contentHeight = Math.max(scrollHeight, naturalHeight);
    const containBody = containedBody && !expanded;
    const footerContent = typeof footer === 'function' ? footer(layout) : footer;
    const footerView = footerContent && <ExpansionRegion id={persistentFooter ? undefined : footerExpansionId} order={3}
        style={[styles.footer, { borderTopColor: theme.colors.outline }]}
        onLayout={(event) => setFooterHeight(event.nativeEvent.layout.height)}
    ><View style={!fullWidthFooter && columnStyle}>{footerContent}</View></ExpansionRegion>;

    const pageContent = (transitioning: boolean) => <>
        {context && <ExpansionRegion id="page-context" order={0} style={[styles.context, { backgroundColor: theme.colors.background, borderBottomColor: theme.colors.outline }]} onLayout={(event) => setContextHeight(event.nativeEvent.layout.height)}>
            <View style={columnStyle}>{context}</View>
        </ExpansionRegion>}
        <ExpansionRegion id={bodyExpansionId} order={2} style={[!fullWidthBody && columnStyle, styles.body, { minHeight: minBodyHeight }, expanded && styles.bodyExpanded, containBody && styles.bodyContained, transitioning && styles.bodyTransitioning]}>
            {typeof children === 'function' ? children(layout) : children}
        </ExpansionRegion>
        {expanded && !persistentFooter && footerView}
    </>;

    return <ColumnStyleContext.Provider value={columnStyle}><View testID={testID} style={[styles.root, { backgroundColor: theme.colors.background }]} onLayout={updateHeight}>
        {Platform.OS === 'web' && <Text ref={probe} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" onLayout={readTextScale} style={styles.probe}>M</Text>}
        {header && <View style={{ backgroundColor: theme.colors.summaryContainer }} onLayout={event => setHeaderHeight(event.nativeEvent.layout.height)}><View style={columnStyle}>{header}</View></View>}
        <PageExpansion config={expansion} columnStyle={columnStyle} footer={persistentFooter && footerView}>{blocked => <>
        {containBody ? <View role="main" testID="fixed-page-content" style={styles.scroller}>
            {pageContent(blocked)}
        </View> : <ScrollView
            role="main"
            testID="fixed-page-scroll"
            style={styles.scroller}
            contentContainerStyle={[styles.scrollContent, !expanded && scrollHeight > 0 && { height: contentHeight }]}
            onLayout={(event) => { setScrollHeight(event.nativeEvent.layout.height); readTextScale(); }}
            keyboardShouldPersistTaps="handled"
            scrollEnabled={!blocked}
        >
            {pageContent(blocked)}
        </ScrollView>}
        {!expanded && !persistentFooter && footerView}
        </>}</PageExpansion>
    </View></ColumnStyleContext.Provider>;

}

const styles = StyleSheet.create({
    root: { flex: 1, minHeight: 0 },
    scroller: { flex: 1, minHeight: 0 },
    scrollContent: { flexGrow: 1 },
    column: { width: '100%', alignSelf: 'center', minWidth: 0 },
    context: { borderBottomWidth: StyleSheet.hairlineWidth },
    body: { flex: 1 },
    bodyExpanded: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
    // Let the body own scrolling within the space left by the fixed context and footer.
    bodyContained: { minHeight: 0, overflow: 'hidden' },
    // Moving child regions clip at the pane/header edge, not the body's resting bounds.
    bodyTransitioning: { overflow: 'visible' },
    footer: { flexShrink: 0, borderTopWidth: StyleSheet.hairlineWidth },
    probe: { position: 'absolute', opacity: 0, fontSize: TEXT_PROBE_SIZE, pointerEvents: 'none' }
});
