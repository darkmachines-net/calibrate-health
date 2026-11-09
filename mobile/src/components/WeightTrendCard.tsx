/** @file Expanded weight trend with date-window navigation, panning, and independent weigh-in selection. */

import React, { useMemo, useRef, useState } from 'react';
import {
    Platform,
    Pressable,
    StyleSheet,
    View,
    useWindowDimensions,
    type AccessibilityActionEvent,
    type ViewProps
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
    WeightTrendChart,
    TrendChartLegend,
    buildWeightTrendVisualization,
    getWeightTrendChartMinimumHeight,
    useWeightTrendChartTypography
} from './WeightTrendChart';
import { AppButton } from './AppButton';
import { AppChip } from './AppChip';
import { AppText } from './AppText';
import { AsyncStateBoundary, useOnlineStatus } from './AsyncStateBoundary';
import { SectionHeader } from './SectionHeader';
import { useFocusVisible } from './useFocusVisible';
import { useAuth } from '../auth/AuthContext';
import { ASYNC_RESOURCE_STATES, resolveAsyncResourceState } from '../asyncState/resolveAsyncState';
import { radius, spacing, useAppTheme, type AppTheme } from '../theme';
import { formatDateOnlyForDisplay } from '../utils/dates';
import { formatWeight } from '../utils/format';
import { WEIGHT_HISTORY_RANGES, weightHistoryDate } from '../weightTrend/historyWindow';
import { useWeightTrendHistory } from '../weightTrend/useWeightTrendHistory';
import { useWeightTrendPan } from '../weightTrend/useWeightTrendPan';
import type { WeightTrendChartPoint } from '../weightTrend/geometry';
import {
    describeVisibleWeightTrend,
    formatEstimatedTrendRange,
    getLatestWeightTrendSnapshot,
} from '../weightTrend/presentation';
import {
    useClientQueryFailureDiagnostic,
    useWeightTrendDegradationDiagnostic
} from '../diagnostics/operationDiagnostics';

type WeightTrendCardProps = ViewProps & {
    title?: string | null;
    description?: string;
    footer?: React.ReactNode;
};

// Provides initial geometry until the chart canvas is measured.
const DEFAULT_CHART_WIDTH = 340;
export { getWeightTrendChartMinimumHeight } from './WeightTrendChart';

type ChartPressNativeEvent = {
    locationX?: unknown;
    offsetX?: unknown;
};

type KeyboardLikeEvent = {
    key?: string;
    nativeEvent?: { key?: string };
    preventDefault?: () => void;
};

function getPointKey(point: WeightTrendChartPoint): string {
    return `${point.metric.id}-${point.dateKey}`;
}

/** React Native reports locationX, while React Native Web forwards the browser click's offsetX. */
function getChartPressX(nativeEvent: ChartPressNativeEvent): number | null {
    const pressX = typeof nativeEvent.locationX === 'number'
        ? nativeEvent.locationX
        : nativeEvent.offsetX;
    return typeof pressX === 'number' && Number.isFinite(pressX) ? pressX : null;
}

function getKeyboardKey(event: KeyboardLikeEvent): string {
    return event.key ?? event.nativeEvent?.key ?? '';
}

function describeSelectedTrendPoint(
    point: WeightTrendChartPoint,
    unit: Parameters<typeof formatWeight>[1]
): string {
    if (!point.hasVisibleTrend) {
        return `Selected ${formatDateOnlyForDisplay(point.dateKey)}. Scale reading ${formatWeight(point.metric.weight, unit)}. No underlying trend estimate is available for this date.`;
    }
    const snapshot = {
        weight: point.metric.trend_weight,
        lower: point.metric.trend_ci_lower,
        upper: point.metric.trend_ci_upper
    };
    return `Selected ${formatDateOnlyForDisplay(point.dateKey)}. Underlying weight estimate ${formatWeight(snapshot.weight, unit)}. 95% trend range ${formatEstimatedTrendRange(snapshot, unit)}. Scale reading ${formatWeight(point.metric.weight, unit)}.`;
}

/** Renders a pannable date window over weight history without changing the selected span. */
export const WeightTrendCard: React.FC<WeightTrendCardProps> = ({
    title = 'Weight trend',
    description,
    footer,
    style,
    ...props
}) => {
    const { user } = useAuth();
    const { width: viewportWidth } = useWindowDimensions();
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const [selectedPointKey, setSelectedPointKey] = useState<string | null>(null);
    const [selectionAnnouncement, setSelectionAnnouncement] = useState('');
    const [chartCanvasWidth, setChartCanvasWidth] = useState(DEFAULT_CHART_WIDTH);
    const [chartCanvasHeight, setChartCanvasHeight] = useState(0);
    const [panPreview, setPanPreview] = useState<{ point: WeightTrendChartPoint | null; weightTicks: number[] } | null>(null);
    const panning = panPreview !== null;
    const pan = useRef({ origin: 0, target: 0 });
    const { axisScale, axisPadding, axisFontSize, axisProbe } = useWeightTrendChartTypography();
    const chartMinHeight = getWeightTrendChartMinimumHeight(viewportWidth) * axisScale;
    const chartHeight = Math.max(chartCanvasHeight, chartMinHeight);
    const history = useWeightTrendHistory();
    const { range, start, end, metrics, trendSummary } = history;
    const panBindings = useWeightTrendPan({
        begin: () => {
            pan.current = { origin: end, target: end };
            setPanPreview({ point: selectedPoint, weightTicks: chartLayout.yTicks.map(({ value }) => value) });
            clearSelection();
        },
        move: (pixels) => {
            const width = Math.max(1, chartCanvasWidth - axisPadding.left - axisPadding.right);
            const next = pan.current.origin - pixels * (range - 1) / width;
            pan.current.target = next;
            history.panTo(next);
        },
        end: () => {
            history.panTo(Math.round(pan.current.target));
            setPanPreview(null);
        }
    });
    const isOnline = useOnlineStatus();
    const chartLayout = useMemo(
        () => buildWeightTrendVisualization(metrics, {
            width: chartCanvasWidth,
            height: chartHeight,
            minHeight: chartMinHeight,
            padding: axisPadding,
            downsampleMeasurements: range === 365,
            modelStartDate: trendSummary?.modeled_start_date,
            dateWindow: { start, end },
            missingWindows: history.missingWindows,
            fixedWeightTicks: panPreview?.weightTicks
        }),
        [axisPadding, chartCanvasWidth, chartHeight, chartMinHeight, end, history.missingWindows, metrics, panPreview, range, start, trendSummary?.modeled_start_date]
    );
    const chartPoints = chartLayout.points;
    const selectedPointIndex = useMemo(() => {
        if (chartPoints.length === 0) return -1;
        if (selectedPointKey === null) return chartPoints.length - 1;
        const matchingIndex = chartPoints.findIndex((point) => getPointKey(point) === selectedPointKey);
        return matchingIndex >= 0 ? matchingIndex : chartPoints.length - 1;
    }, [chartPoints, selectedPointKey]);
    const selectedPoint = selectedPointIndex >= 0 ? chartPoints[selectedPointIndex] : null;
    // Keep the space below the plot stable through gaps while the user is dragging.
    const displayedPoint = panPreview ? panPreview.point : selectedPoint;

    const trendUnavailable = trendSummary?.status === 'unavailable';
    useClientQueryFailureDiagnostic({
        operation: 'weight_trend_load',
        isError: history.error !== null,
        error: history.error,
        errorUpdatedAt: history.errorUpdatedAt
    });
    useWeightTrendDegradationDiagnostic(trendUnavailable, history.dataUpdatedAt);
    const visibleMetrics = chartPoints.map((point) => point.metric);
    const latestSnapshot = getLatestWeightTrendSnapshot(visibleMetrics);
    const visibleTrendSummary = describeVisibleWeightTrend(visibleMetrics, user?.weight_unit);
    const showModelBoundary = range === 365 && chartLayout.modelBoundaryPoint !== null;
    const atLatest = Math.round(end) === history.today;
    const atOldest = Math.round(end) === history.oldestEnd;
    const startDate = weightHistoryDate(start);
    const endDate = weightHistoryDate(end);
    const dateLabel = `${formatDateOnlyForDisplay(startDate, startDate.slice(0, 4) !== endDate.slice(0, 4))} - ${formatDateOnlyForDisplay(endDate)}`;
    let windowStatus = `${range} days`;
    if (atLatest) windowStatus += ' | Latest';
    else if (atOldest) windowStatus += ' | Earliest';
    if (history.loadingPage && chartPoints.length) windowStatus += ' | Loading...';
    let emptyMessage = '';
    const missingPage = history.missingWindows.length > 0;
    const pageState = resolveAsyncResourceState({
        data: missingPage && !chartPoints.length ? undefined : chartPoints.length > 0,
        status: history.error ? 'error' : missingPage ? 'pending' : 'success',
        error: history.error,
        dataUpdatedAt: history.dataUpdatedAt
    }, { isEmpty: (hasPoints) => !hasPoints, isOnline });
    const showPageNotice = pageState.kind === ASYNC_RESOURCE_STATES.ERROR ||
        pageState.kind === ASYNC_RESOURCE_STATES.STALE ||
        pageState.kind === ASYNC_RESOURCE_STATES.DEGRADED;
    if (!chartPoints.length) {
        if (missingPage && isOnline && !history.error) {
            emptyMessage = history.historyCount ? 'Loading weight history...' : 'Loading trend...';
        }
        else if (!missingPage && !history.error && isOnline) {
            emptyMessage = history.historyCount ? 'No weigh-ins in this window' : 'Log a weigh-in to start a trend.';
        }
    }
    const firstWeighIn = history.historyCount === 1 && chartPoints.length === 1 ? chartPoints[0] : null;
    const showChart = !firstWeighIn && (history.historyCount > 0 || chartPoints.length > 0);
    const accessibleChartSummary = latestSnapshot
        ? `Weight chart from ${formatDateOnlyForDisplay(chartPoints[0]?.dateKey ?? '')} to ${formatDateOnlyForDisplay(chartPoints[chartPoints.length - 1]?.dateKey ?? '')}, with ${chartPoints.length} measurements. Latest smoothed weight ${formatWeight(latestSnapshot.weight, user?.weight_unit)}. 95% estimated trend range ${formatEstimatedTrendRange(latestSnapshot, user?.weight_unit)}.`
        : `Weight chart with ${chartPoints.length} measurements. Smoothed estimates are not available for this selected history.`;

    function clearSelection() {
        setSelectedPointKey(null);
        setSelectionAnnouncement('');
    }

    function selectPoint(point: WeightTrendChartPoint) {
        setSelectedPointKey(getPointKey(point));
        setSelectionAnnouncement(describeSelectedTrendPoint(point, user?.weight_unit));
    }

    function selectNearestPoint(locationX: number | null) {
        if (chartPoints.length === 0 || locationX === null) return;
        const scaledX = (locationX / Math.max(chartCanvasWidth, 1)) * chartLayout.width;
        const nearestPoint = chartPoints.reduce((nearest, point) => (
            Math.abs(point.x - scaledX) < Math.abs(nearest.x - scaledX) ? point : nearest
        ), chartPoints[0]);
        selectPoint(nearestPoint);
    }

    function selectPointAtIndex(index: number) {
        const point = chartPoints[index];
        if (point) selectPoint(point);
    }

    function handleChartKeyDown(event: KeyboardLikeEvent) {
        const key = getKeyboardKey(event);
        let nextIndex: number | undefined;
        if (key === 'ArrowLeft') nextIndex = Math.max(0, selectedPointIndex - 1);
        if (key === 'ArrowRight') nextIndex = Math.min(chartPoints.length - 1, selectedPointIndex + 1);
        if (key === 'Home') nextIndex = 0;
        if (key === 'End') nextIndex = chartPoints.length - 1;
        if (nextIndex === undefined) return;
        event.preventDefault?.();
        selectPointAtIndex(nextIndex);
    }

    function handleChartAccessibilityAction(event: AccessibilityActionEvent) {
        const actionName = event.nativeEvent.actionName;
        if (actionName === 'decrement') selectPointAtIndex(Math.max(0, selectedPointIndex - 1));
        if (actionName === 'increment') selectPointAtIndex(Math.min(chartPoints.length - 1, selectedPointIndex + 1));
    }

    return (
        <View {...props} style={[styles.content, style]}>
            {axisProbe}
            {(title || description) && <SectionHeader title={title ?? ''} description={description} />}
            <View style={styles.rangeRow}>
                {WEIGHT_HISTORY_RANGES.map((option) => (
                    <AppChip
                        key={option.days}
                        label={option.label}
                        selected={option.days === range}
                        onPress={() => {
                            history.chooseRange(option.days);
                            clearSelection();
                        }}
                        style={styles.rangeChip}
                    />
                ))}
            </View>
            {trendUnavailable ? (
                <View testID="weight-trend-unavailable" accessibilityRole="alert" style={styles.unavailableNotice}>
                    <AppText variant="subtitle">Trend estimate temporarily unavailable</AppText>
                    <AppText variant="body">
                        Your scale readings are still shown. Try again later for the underlying trend.
                    </AppText>
                </View>
            ) : null}
            <View testID="weight-trend-chart-shell" style={styles.chartShell}>
                <View accessibilityRole="toolbar" accessibilityLabel="Weight history window" style={styles.windowBar}>
                    <WindowStepButton direction={-1} days={range} disabled={atOldest} onPress={() => {
                        clearSelection();
                        history.shiftWindow(-1);
                    }} />
                    <View style={styles.windowLabel} testID="weight-history-window" accessibilityLiveRegion={panning ? 'none' : 'polite'}>
                        <AppText variant="label" style={styles.centered}>{dateLabel}</AppText>
                        <AppText variant="caption" style={styles.centered}>{windowStatus}</AppText>
                    </View>
                    <WindowStepButton direction={1} days={range} disabled={atLatest} onPress={() => {
                        clearSelection();
                        history.shiftWindow(1);
                    }} />
                </View>
                <View
                    ref={panBindings.ref}
                    testID="weight-trend-chart-canvas"
                    style={[
                        styles.chartCanvas,
                        { minHeight: chartMinHeight }
                    ]}
                    onLayout={(event) => {
                        setChartCanvasWidth(event.nativeEvent.layout.width);
                        setChartCanvasHeight(event.nativeEvent.layout.height);
                    }}
                >
                    {showChart && <WeightTrendChart
                        chartLayout={chartLayout}
                        padding={axisPadding}
                        axisFontSize={axisFontSize}
                        unit={user?.weight_unit}
                        accessibleChartSummary={accessibleChartSummary}
                        selectedPoint={panning ? null : selectedPoint}
                        showModelBoundary={showModelBoundary}
                        clipTrendToWindow
                    />}
                    {firstWeighIn && (
                        <View style={styles.singlePointState}>
                            <View style={styles.singlePointIcon}>
                                <Ionicons name="scale-outline" size={24} color={theme.colors.primary} />
                            </View>
                            <View style={styles.singlePointText}>
                                <AppText variant="subtitle">First weigh-in recorded</AppText>
                                <AppText variant="body">
                                    {formatWeight(firstWeighIn.metric.weight, user?.weight_unit)} on{' '}
                                    {formatDateOnlyForDisplay(firstWeighIn.dateKey)}
                                </AppText>
                                <AppText variant="muted">Log one more weigh-in to reveal your trend.</AppText>
                            </View>
                        </View>
                    )}
                    {!!emptyMessage && (
                        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.emptyChart]}>
                            <AppText variant="muted" style={styles.centered}>{emptyMessage}</AppText>
                        </View>
                    )}
                    <View {...panBindings.panHandlers} style={StyleSheet.absoluteFill} pointerEvents={firstWeighIn ? 'none' : 'auto'}>
                        {chartPoints.length > 0 && !firstWeighIn && <Pressable
                            accessibilityActions={[
                                { name: 'decrement', label: 'Previous weigh-in' },
                                { name: 'increment', label: 'Next weigh-in' }
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel="Select nearest weigh-in"
                            accessibilityHint="Use Left and Right arrow keys, or Home and End, to review weigh-ins. Use the window buttons to browse older dates."
                            onAccessibilityAction={handleChartAccessibilityAction}
                            focusable={Platform.OS === 'web'}
                            onPress={(event) => selectNearestPoint(getChartPressX(event.nativeEvent))}
                            {...({ onKeyDown: handleChartKeyDown } as object)}
                            style={StyleSheet.absoluteFill}
                        />}
                    </View>
                </View>
                <View style={styles.historyActions}>
                    <View style={styles.dragHint}>
                        <Ionicons name="swap-horizontal" size={16} color={theme.colors.onSurfaceVariant} />
                        <AppText variant="caption">{Platform.OS === 'web' ? 'Drag or swipe to browse' : 'Swipe to browse'}</AppText>
                    </View>
                    <AppButton title="Back to today" variant="ghost" disabled={atLatest} onPress={() => {
                        clearSelection();
                        history.panTo(history.today);
                    }} />
                </View>
                {showPageNotice && (
                    <AsyncStateBoundary state={pageState} resourceLabel="weight trend" loading={null} empty={null}
                        onRetry={isOnline ? history.retry : undefined} retrying={history.isFetching}>
                        {null}
                    </AsyncStateBoundary>
                )}
                {showModelBoundary && chartLayout.modelBoundaryPoint && (
                    <AppText variant="caption" style={styles.boundaryNote}>
                        Smoothed trend starts {formatDateOnlyForDisplay(chartLayout.modelBoundaryPoint.dateKey)}. Earlier dots are measurements only.
                    </AppText>
                )}
                {!firstWeighIn && displayedPoint && <TrendChartLegend />}
                {displayedPoint && !firstWeighIn && (
                    <SelectedTrendPanel
                        point={displayedPoint}
                        unit={user?.weight_unit}
                        trendUnavailable={trendUnavailable}
                        freshness={atLatest && selectedPointIndex === chartPoints.length - 1
                            ? trendSummary?.freshness ?? (trendSummary?.status === 'stale' ? 'stale' : 'current')
                            : null}
                    />
                )}
                {displayedPoint && !firstWeighIn && (
                    <View accessibilityRole="toolbar" accessibilityLabel="Selected weigh-in navigation" style={styles.pointNavigation}>
                        <PointNavigationButton
                            direction="previous"
                            disabled={selectedPointIndex <= 0}
                            onPress={() => selectPointAtIndex(selectedPointIndex - 1)}
                        />
                        <PointNavigationButton
                            direction="next"
                            disabled={selectedPointIndex >= chartPoints.length - 1}
                            onPress={() => selectPointAtIndex(selectedPointIndex + 1)}
                        />
                    </View>
                )}
                <AppText
                    testID="weight-trend-selection-announcement"
                    accessibilityLiveRegion="polite"
                    role="status"
                    style={styles.liveStatus}
                >
                    {selectionAnnouncement}
                </AppText>
                {!trendSummary && !firstWeighIn && chartPoints.length > 0 && (
                    <AppText variant="caption" style={styles.summary}>
                        {visibleTrendSummary}
                    </AppText>
                )}
            </View>
            {footer}
        </View>
    );
};

const SelectedTrendPanel: React.FC<{
    point: WeightTrendChartPoint;
    unit: Parameters<typeof formatWeight>[1];
    freshness: 'current' | 'stale' | 'outdated' | 'unavailable' | null;
    trendUnavailable: boolean;
}> = ({ point, unit, freshness, trendUnavailable }) => {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const [isRangeInfoHovered, setIsRangeInfoHovered] = useState(false);
    const [isRangeInfoFocused, setIsRangeInfoFocused] = useState(false);
    const [isRangeInfoPinned, setIsRangeInfoPinned] = useState(false);
    const rangeFocus = useFocusVisible(
        () => setIsRangeInfoFocused(true),
        () => setIsRangeInfoFocused(false)
    );
    const showRangeTooltip = isRangeInfoHovered || isRangeInfoFocused || isRangeInfoPinned;
    let freshnessLabel = '';
    if (freshness === 'stale') freshnessLabel = 'Based on an older weigh-in';
    if (freshness === 'outdated') freshnessLabel = 'Current weigh-in needed';
    const trendSnapshot = point.hasVisibleTrend
        ? {
            weight: point.metric.trend_weight,
            lower: point.metric.trend_ci_lower,
            upper: point.metric.trend_ci_upper
        }
        : null;
    const accessibilityLabel = describeSelectedTrendPoint(point, unit);

    return (
        <View
            testID="selected-trend-summary"
            accessibilityLabel={accessibilityLabel}
            style={styles.snapshotPanel}
        >
            <View style={styles.snapshotHeader}>
                <AppText variant="caption">
                    {trendSnapshot ? 'Underlying weight estimate' : 'Scale reading'}
                </AppText>
                <AppText variant="caption">{formatDateOnlyForDisplay(point.dateKey)}</AppText>
            </View>
            {trendSnapshot ? (
                <>
                    <AppText variant="screenTitle" style={styles.snapshotValue}>
                        {formatWeight(trendSnapshot.weight, unit)}
                    </AppText>
                    {freshnessLabel ? <AppText variant="caption">{freshnessLabel}</AppText> : null}
                    <View style={styles.snapshotRangeRow}>
                        <AppText variant="caption">95% trend range {formatEstimatedTrendRange(trendSnapshot, unit)}</AppText>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="About the 95% trend range"
                            accessibilityHint="This range shows uncertainty in the estimate, not expected scale readings."
                            accessibilityState={{ expanded: showRangeTooltip }}
                            onHoverIn={() => setIsRangeInfoHovered(true)}
                            onHoverOut={() => setIsRangeInfoHovered(false)}
                            onFocus={rangeFocus.handleFocus}
                            onBlur={rangeFocus.handleBlur}
                            onPress={() => setIsRangeInfoPinned((current) => !current)}
                            style={({ pressed }) => [styles.rangeInfoButton, pressed && styles.pressed, rangeFocus.focusVisible && styles.focusVisible]}
                        >
                            <Ionicons name="information-circle-outline" size={17} color={theme.colors.onSurfaceVariant} />
                            {showRangeTooltip ? (
                                <View testID="trend-range-tooltip" role="tooltip" pointerEvents="none" style={styles.rangeTooltip}>
                                    <AppText variant="caption" style={styles.rangeTooltipText}>
                                        This range shows uncertainty in the estimate, not expected scale readings.
                                    </AppText>
                                </View>
                            ) : null}
                        </Pressable>
                    </View>
                    <View style={styles.snapshotMeasurementRow}>
                        <AppText variant="caption">Scale reading</AppText>
                        <AppText variant="label">{formatWeight(point.metric.weight, unit)}</AppText>
                    </View>
                </>
            ) : (
                <>
                    <AppText variant="screenTitle" style={styles.snapshotValue}>
                        {formatWeight(point.metric.weight, unit)}
                    </AppText>
                    <AppText variant="caption">
                        {trendUnavailable
                            ? 'The underlying trend is temporarily unavailable, but this scale reading is saved.'
                            : 'This older point has no underlying trend estimate.'}
                    </AppText>
                </>
            )}
        </View>
    );
};

function WindowStepButton({ direction, days, disabled, onPress }: {
    direction: -1 | 1;
    days: number;
    disabled: boolean;
    onPress: () => void;
}) {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${direction < 0 ? 'Previous' : 'Next'} ${days} days`}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onPress={onPress}
            style={({ pressed }) => [styles.windowStep, pressed && styles.pressed, disabled && styles.disabled, focusVisible && styles.focusVisible]}
        >
            <Ionicons name={direction < 0 ? 'chevron-back' : 'chevron-forward'} size={20} color={theme.colors.primary} />
        </Pressable>
    );
}

const PointNavigationButton: React.FC<{
    direction: 'previous' | 'next';
    disabled: boolean;
    onPress: () => void;
}> = ({ direction, disabled, onPress }) => {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const previous = direction === 'previous';
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();
    const label = previous ? 'Previous weigh-in' : 'Next weigh-in';
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onPress={onPress}
            style={({ pressed }) => [styles.pointNavigationButton, pressed && !disabled && styles.pressed, disabled && styles.disabled, focusVisible && styles.focusVisible]}
        >
            {previous && <Ionicons name="chevron-back" size={16} color={theme.colors.primary} />}
            <AppText variant="label" style={styles.pointNavigationLabel}>{previous ? 'Previous' : 'Next'}</AppText>
            {!previous && <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />}
        </Pressable>
    );
};

const createStyles = (theme: AppTheme) => StyleSheet.create({
    content: { width: '100%', gap: spacing.md },
    rangeRow: { flexDirection: 'row', gap: spacing.sm },
    rangeChip: { flex: 1, paddingHorizontal: spacing.xs },
    chartShell: {
        flexGrow: 1,
        borderRadius: radius.md,
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.outlineVariant,
        borderWidth: StyleSheet.hairlineWidth,
        padding: spacing.sm,
        gap: spacing.sm
    },
    chartCanvas: { position: 'relative', flexGrow: 1, flexShrink: 1 },
    windowBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        paddingBottom: spacing.sm,
        borderBottomColor: theme.colors.outlineVariant,
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    windowLabel: { flex: 1, minWidth: 0, gap: spacing.xs },
    centered: { textAlign: 'center' },
    windowStep: {
        width: theme.interaction.minimumTouchTarget,
        height: theme.interaction.minimumTouchTarget,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.md,
        borderColor: theme.colors.outlineVariant,
        borderWidth: StyleSheet.hairlineWidth
    },
    historyActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        columnGap: spacing.xs
    },
    dragHint: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    emptyChart: {
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacing.lg
    },
    unavailableNotice: {
        borderRadius: radius.md,
        backgroundColor: theme.colors.infoContainer,
        padding: spacing.md,
        gap: spacing.xs
    },
    singlePointState: {
        flexGrow: 1,
        minHeight: 116,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        borderRadius: radius.md,
        backgroundColor: theme.colors.surfaceContainer,
        padding: spacing.lg
    },
    singlePointIcon: {
        width: 52,
        height: 52,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.pill,
        backgroundColor: theme.colors.primaryContainer
    },
    singlePointText: { flex: 1, minWidth: 0, gap: spacing.xs },
    snapshotPanel: {
        position: 'relative',
        zIndex: 2,
        borderRadius: radius.md,
        borderColor: theme.colors.outlineVariant,
        borderWidth: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.surfaceContainer,
        padding: spacing.md,
        gap: spacing.xs
    },
    snapshotHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: spacing.sm
    },
    snapshotValue: { color: theme.colors.onSurface },
    snapshotRangeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs },
    snapshotMeasurementRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: spacing.sm,
        paddingTop: spacing.xs
    },
    rangeInfoButton: {
        position: 'relative',
        zIndex: 3,
        minWidth: theme.interaction.minimumTouchTarget,
        minHeight: theme.interaction.minimumTouchTarget,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.pill
    },
    rangeTooltip: {
        position: 'absolute',
        top: theme.interaction.minimumTouchTarget,
        right: 0,
        width: 220,
        zIndex: 3,
        borderRadius: radius.sm,
        borderColor: theme.colors.outlineVariant,
        borderWidth: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.surfaceContainerHigh,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.sm,
        ...theme.shadows.raised
    },
    rangeTooltipText: { color: theme.colors.onSurface },
    liveStatus: { height: 0, overflow: 'hidden' },
    summary: { textAlign: 'center' },
    boundaryNote: { color: theme.colors.onSurfaceVariant, textAlign: 'center' },
    pointNavigation: { flexDirection: 'row', gap: spacing.sm },
    pointNavigationButton: {
        flex: 1,
        minHeight: theme.interaction.minimumTouchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.xs,
        borderRadius: radius.md,
        borderColor: theme.colors.outlineVariant,
        borderWidth: StyleSheet.hairlineWidth
    },
    pointNavigationLabel: { color: theme.colors.primary },
    focusVisible: {
        outlineWidth: theme.interaction.focusRingWidth,
        outlineStyle: 'solid',
        outlineColor: theme.colors.focusRing
    },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    disabled: { opacity: 0.45 },
});
