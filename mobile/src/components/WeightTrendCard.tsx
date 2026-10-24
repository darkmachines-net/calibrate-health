import React, { useMemo, useState } from 'react';
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
import { useQuery } from '@tanstack/react-query';
import { AppChip } from './AppChip';
import { AppText } from './AppText';
import { AsyncStateBoundary, useAsyncResourceState, useOnlineStatus } from './AsyncStateBoundary';
import { LoadingState } from './LoadingState';
import { SectionHeader } from './SectionHeader';
import { useFocusVisible } from './useFocusVisible';
import { useAuth } from '../auth/AuthContext';
import { radius, spacing, useAppTheme, type AppTheme } from '../theme';
import { formatDateOnlyForDisplay } from '../utils/dates';
import { formatWeight } from '../utils/format';
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

type TrendRange = 'week' | 'month' | 'year' | 'all';

type WeightTrendCardProps = ViewProps & {
    title?: string | null;
    description?: string;
    footer?: React.ReactNode;
};

const RANGE_OPTIONS: Array<{ value: TrendRange; label: string }> = [
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
    { value: 'year', label: 'Year' },
    { value: 'all', label: 'All' }
];

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

export const WeightTrendCard: React.FC<WeightTrendCardProps> = ({
    title = 'Weight trend',
    description,
    footer,
    style,
    ...props
}) => {
    const { api, user } = useAuth();
    const { width: viewportWidth } = useWindowDimensions();
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const [range, setRange] = useState<TrendRange>('month');
    const [selectedPointKey, setSelectedPointKey] = useState<string | null>(null);
    const [selectionAnnouncement, setSelectionAnnouncement] = useState('');
    const [chartCanvasWidth, setChartCanvasWidth] = useState(DEFAULT_CHART_WIDTH);
    const [chartCanvasHeight, setChartCanvasHeight] = useState(0);
    const { axisScale, axisPadding, axisFontSize, axisProbe } = useWeightTrendChartTypography();
    const chartMinHeight = getWeightTrendChartMinimumHeight(viewportWidth) * axisScale;
    const chartHeight = Math.max(chartCanvasHeight, chartMinHeight);
    const trendQuery = useQuery({
        queryKey: ['mobile-metrics-trend', range],
        queryFn: () => api.getTrendMetrics({ range })
    });
    const isOnline = useOnlineStatus();
    const trendState = useAsyncResourceState(trendQuery, (data) => data.metrics.length === 0);
    const metrics = useMemo(() => trendQuery.data?.metrics ?? [], [trendQuery.data?.metrics]);
    const trendSummary = trendQuery.data?.meta.trend_summary;
    const chartLayout = useMemo(
        () => buildWeightTrendVisualization(metrics, {
            width: chartCanvasWidth,
            height: chartHeight,
            minHeight: chartMinHeight,
            padding: axisPadding,
            downsampleMeasurements: range === 'all',
            modelStartDate: trendSummary?.modeled_start_date
        }),
        [axisPadding, chartCanvasWidth, chartHeight, chartMinHeight, metrics, range, trendSummary?.modeled_start_date]
    );
    const chartPoints = chartLayout.points;
    const selectedPointIndex = useMemo(() => {
        if (chartPoints.length === 0) return -1;
        if (selectedPointKey === null) return chartPoints.length - 1;
        const matchingIndex = chartPoints.findIndex((point) => getPointKey(point) === selectedPointKey);
        return matchingIndex >= 0 ? matchingIndex : chartPoints.length - 1;
    }, [chartPoints, selectedPointKey]);
    const selectedPoint = selectedPointIndex >= 0 ? chartPoints[selectedPointIndex] : null;

    const hasWeightHistory = (trendQuery.data?.meta.total_points ?? 0) > 0;
    const trendUnavailable = trendSummary?.status === 'unavailable';
    useClientQueryFailureDiagnostic({
        operation: 'weight_trend_load',
        isError: trendQuery.isError,
        error: trendQuery.error,
        errorUpdatedAt: trendQuery.errorUpdatedAt
    });
    useWeightTrendDegradationDiagnostic(trendUnavailable, trendQuery.dataUpdatedAt);
    const latestSnapshot = getLatestWeightTrendSnapshot(metrics, trendSummary);
    const visibleTrendSummary = describeVisibleWeightTrend(metrics, user?.weight_unit);
    const showModelBoundary = (range === 'year' || range === 'all') && chartLayout.modelBoundaryPoint !== null;
    const accessibleChartSummary = latestSnapshot
        ? `Weight chart from ${formatDateOnlyForDisplay(chartPoints[0]?.dateKey ?? '')} to ${formatDateOnlyForDisplay(chartPoints[chartPoints.length - 1]?.dateKey ?? '')}, with ${chartPoints.length} measurements. Latest smoothed weight ${formatWeight(latestSnapshot.weight, user?.weight_unit)}. 95% estimated trend range ${formatEstimatedTrendRange(latestSnapshot, user?.weight_unit)}.`
        : `Weight chart with ${chartPoints.length} measurements. Smoothed estimates are not available for this selected history.`;

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
                {RANGE_OPTIONS.map((option) => (
                    <AppChip
                        key={option.value}
                        label={option.label}
                        selected={option.value === range}
                        onPress={() => {
                            setRange(option.value);
                            setSelectedPointKey(null);
                            setSelectionAnnouncement('');
                        }}
                        style={styles.rangeChip}
                    />
                ))}
            </View>
            <AsyncStateBoundary
                contentStyle={styles.trendBody}
                state={trendState}
                resourceLabel="weight trend"
                loading={<LoadingState label="Loading trend..." />}
                empty={(
                    <View style={styles.emptyChart}>
                        <AppText variant="muted">
                            {hasWeightHistory
                                ? 'No weigh-ins in this range. Choose All to view your weight history.'
                                : 'Log a weigh-in to start a trend.'}
                        </AppText>
                    </View>
                )}
                onRetry={isOnline ? () => trendQuery.refetch() : undefined}
                retrying={trendQuery.isFetching}
            >
            {trendUnavailable ? (
                <View testID="weight-trend-unavailable" accessibilityRole="alert" style={styles.unavailableNotice}>
                    <AppText variant="subtitle">Trend estimate temporarily unavailable</AppText>
                    <AppText variant="body">
                        Your scale readings are still shown. Try again later for the underlying trend.
                    </AppText>
                </View>
            ) : null}
            {chartPoints.length === 1 ? (
                <View
                    accessibilityLabel={`First weigh-in recorded at ${formatWeight(chartPoints[0].metric.weight, user?.weight_unit)}`}
                    style={styles.singlePointState}
                >
                    <View style={styles.singlePointIcon}>
                        <Ionicons name="scale-outline" size={24} color={theme.colors.primary} />
                    </View>
                    <View style={styles.singlePointText}>
                        <AppText variant="subtitle">First weigh-in recorded</AppText>
                        <AppText variant="body">
                            {formatWeight(chartPoints[0].metric.weight, user?.weight_unit)} on{' '}
                            {formatDateOnlyForDisplay(chartPoints[0].dateKey)}
                        </AppText>
                        <AppText variant="muted">Log one more weigh-in to reveal your trend.</AppText>
                    </View>
                </View>
            ) : (
                <View testID="weight-trend-chart-shell" style={styles.chartShell}>
                    <View
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
                        <WeightTrendChart
                            chartLayout={chartLayout}
                            padding={axisPadding}
                            axisFontSize={axisFontSize}
                            unit={user?.weight_unit}
                            accessibleChartSummary={accessibleChartSummary}
                            selectedPoint={selectedPoint}
                            showModelBoundary={showModelBoundary}
                        />
                        <Pressable
                            accessibilityActions={[
                                { name: 'decrement', label: 'Previous weigh-in' },
                                { name: 'increment', label: 'Next weigh-in' }
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel="Select nearest weigh-in"
                            accessibilityHint="Use Left and Right arrow keys, or Home and End, to review weigh-ins. Previous and Next buttons follow the chart."
                            onAccessibilityAction={handleChartAccessibilityAction}
                            focusable={Platform.OS === 'web'}
                            onPress={(event) => selectNearestPoint(getChartPressX(event.nativeEvent))}
                            {...({ onKeyDown: handleChartKeyDown } as object)}
                            style={StyleSheet.absoluteFill}
                        />
                    </View>
                    {showModelBoundary && chartLayout.modelBoundaryPoint && (
                        <AppText variant="caption" style={styles.boundaryNote}>
                            Smoothed trend starts {formatDateOnlyForDisplay(chartLayout.modelBoundaryPoint.dateKey)}. Earlier dots are measurements only.
                        </AppText>
                    )}
                    <TrendChartLegend />
                    {selectedPoint && (
                        <SelectedTrendPanel
                            point={selectedPoint}
                            unit={user?.weight_unit}
                            trendUnavailable={trendUnavailable}
                            freshness={selectedPointIndex === chartPoints.length - 1
                                ? trendSummary?.freshness ?? (trendSummary?.status === 'stale' ? 'stale' : 'current')
                                : null}
                        />
                    )}
                    {selectedPoint && (
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
                    {!trendSummary && (
                        <AppText variant="caption" style={styles.summary}>
                            {visibleTrendSummary}
                        </AppText>
                    )}
                </View>
            )}
            </AsyncStateBoundary>
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
    trendBody: { flexGrow: 1 },
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
    emptyChart: {
        flexGrow: 1,
        minHeight: getWeightTrendChartMinimumHeight(0),
        borderRadius: radius.md,
        backgroundColor: theme.colors.surfaceContainer,
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
    error: { color: theme.colors.danger }
});
