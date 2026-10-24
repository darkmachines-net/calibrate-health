import React, { useLayoutEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
    WeightTrendChart,
    buildWeightTrendVisualization,
    getWeightTrendChartMinimumHeight,
    getWeightTrendPreviewMinimumHeight,
    useWeightTrendChartTypography
} from '../WeightTrendChart';
import { useQuery } from '@tanstack/react-query';
import { AppButton } from '../AppButton';
import { FixedPageColumn } from '../FixedPage';
import { useFocusVisible } from '../useFocusVisible';
import { AppText } from '../AppText';
import { AsyncStateBoundary, useAsyncResourceState, useOnlineStatus } from '../AsyncStateBoundary';
import { SkeletonBlock } from '../SkeletonBlock';
import { useAuth } from '../../auth/AuthContext';
import { spacing, useAppTheme, type AppTheme } from '../../theme';
import { ASYNC_RESOURCE_STATES } from '../../asyncState/resolveAsyncState';
import { dateOnlyToLocalDate } from '../../utils/dates';
import { formatWeight } from '../../utils/format';
import { getLatestWeightTrendSnapshot } from '../../weightTrend/presentation';

type WeightTrendPreviewCardProps = {
    onPress: () => void;
    onLogWeight: () => void;
    onMinimumHeightChange?: (height: number) => void;
    suppressStaleNotice?: boolean;
    expanded?: boolean;
};

type PreviewCanvasSize = {
    width: number;
    height: number;
};

const DEFAULT_PREVIEW_WIDTH = 340;
const MIN_PREVIEW_HEIGHT = getWeightTrendChartMinimumHeight(0);

function formatPreviewDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
        .format(dateOnlyToLocalDate(value));
}

export const WeightTrendPreviewCard: React.FC<WeightTrendPreviewCardProps> = ({ onPress, onLogWeight, onMinimumHeightChange, suppressStaleNotice, expanded = false }) => {
    const { api, user } = useAuth();
    const theme = useAppTheme();
    const { width } = useWindowDimensions();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const { axisScale, axisPadding, axisFontSize, axisProbe } = useWeightTrendChartTypography();
    const chartMinHeight = getWeightTrendChartMinimumHeight(width) * axisScale;
    const [headingHeight, setHeadingHeight] = useState<number>();
    const [actionHeight, setActionHeight] = useState(0);
    const previewStyle = [styles.preview, { minHeight: chartMinHeight }, expanded && [styles.previewExpanded, { height: chartMinHeight }]];
    const [canvasSize, setCanvasSize] = useState<PreviewCanvasSize>({
        width: DEFAULT_PREVIEW_WIDTH,
        height: MIN_PREVIEW_HEIGHT
    });
    const trendQuery = useQuery({
        queryKey: ['mobile-metrics-trend', 'month'],
        queryFn: () => api.getTrendMetrics({ range: 'month' })
    });
    const metrics = useMemo(() => trendQuery.data?.metrics ?? [], [trendQuery.data?.metrics]);
    const trendSummary = trendQuery.data?.meta.trend_summary;
    const latestSnapshot = getLatestWeightTrendSnapshot(metrics, trendSummary);
    const freshness = trendSummary?.freshness ?? (trendSummary?.status === 'stale' ? 'stale' : 'current');
    const estimateIsOutdated = freshness === 'outdated';
    const minimumHeight = getWeightTrendPreviewMinimumHeight(width, {
        chartScale: axisScale,
        headingHeight,
        actionHeight: estimateIsOutdated ? Math.max(actionHeight, theme.interaction.minimumTouchTarget) : 0
    });
    // Budget wrapped headings and the optional recovery action without measuring the flexible plot.
    useLayoutEffect(() => {
        onMinimumHeightChange?.(minimumHeight);
    }, [minimumHeight, onMinimumHeightChange]);
    const estimateIsUnavailable = freshness === 'unavailable' || trendSummary?.status === 'unavailable';
    const estimateIsSuppressed = estimateIsOutdated || estimateIsUnavailable;
    const metricDates = metrics
        .map((metric) => metric.date.split('T')[0])
        .filter(Boolean)
        .sort();
    const latestMetricDate = metricDates[metricDates.length - 1];
    const trendAsOfDate = trendSummary?.latest_observation_date ?? latestMetricDate;
    const formattedTrendDate = trendAsOfDate ? formatPreviewDate(trendAsOfDate) : null;
    let trendMetadata: string | null = null;
    if (estimateIsOutdated) {
        trendMetadata = formattedTrendDate
            ? `Estimate out of date | Last scale weight ${formattedTrendDate}`
            : 'Estimate out of date';
    } else if (estimateIsUnavailable) {
        trendMetadata = 'Trend estimate temporarily unavailable';
    } else if (latestSnapshot) {
        const estimate = formatWeight(latestSnapshot.weight, user?.weight_unit);
        if (freshness === 'stale') {
            trendMetadata = formattedTrendDate
                ? `Underlying trend: ${estimate} | As of ${formattedTrendDate}`
                : `Older underlying trend: ${estimate}`;
        } else {
            trendMetadata = `${estimate} underlying trend`;
        }
    }
    const chartLayout = useMemo(
        () => buildWeightTrendVisualization(metrics, {
            width: canvasSize.width,
            height: canvasSize.height,
            minHeight: chartMinHeight,
            padding: axisPadding
        }),
        [axisPadding, canvasSize, chartMinHeight, metrics]
    );
    const points = chartLayout.points;
    const hasWeightHistory = (trendQuery.data?.meta.total_points ?? 0) > 0;
    const isOnline = useOnlineStatus();
    const trendState = useAsyncResourceState(
        trendQuery,
        (data) => data.metrics.length === 0 && data.meta.trend_summary?.freshness !== 'outdated'
    );
    let suppressedEstimateMessage: string | null = null;
    if (estimateIsOutdated) {
        suppressedEstimateMessage = 'Log a current scale weight to refresh the underlying trend estimate.';
    } else if (estimateIsUnavailable) {
        suppressedEstimateMessage = 'Your scale weights are saved, but the underlying trend estimate is temporarily unavailable.';
    }

    const heading = (
        <View testID="trend-preview-heading" style={styles.heading} onLayout={event => setHeadingHeight(event.nativeEvent.layout.height)}>
            <View testID="trend-preview-heading-line" style={styles.headingCopy}>
                <AppText variant="section" accessibilityRole="header">Trend</AppText>
                {trendMetadata && <AppText variant="muted">{trendMetadata}</AppText>}
            </View>
            <View testID="trend-preview-expand-icon" style={styles.expandIcon} pointerEvents="none"
                accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
                <Ionicons name="expand-outline" size={20} color={theme.colors.primary} />
            </View>
        </View>
    );
    const Slot = trendState.kind === ASYNC_RESOURCE_STATES.ERROR ? FixedPageColumn : View;
    return (
        <Slot style={[
            styles.flexSlot,
            { minHeight: minimumHeight },
            trendState.kind === ASYNC_RESOURCE_STATES.ERROR && styles.errorSlot,
            expanded && styles.expanded
        ]}>
            {axisProbe}
            <AsyncStateBoundary
                state={trendState}
                resourceLabel="weight trend"
                contentStyle={styles.boundaryContent}
                loading={<TrendTarget onPress={onPress}>
                    {heading}
                    <SkeletonBlock height={chartMinHeight} />
                </TrendTarget>}
                empty={
                    <TrendTarget onPress={onPress}>
                        {heading}
                        <View testID="weight-trend-preview-canvas" style={previewStyle}>
                            <AppText variant="muted">
                                {hasWeightHistory
                                    ? 'No weigh-ins in the last four weeks. Open Details to view your history.'
                                    : 'Log a weigh-in to start a trend.'}
                            </AppText>
                        </View>
                    </TrendTarget>
                }
                onRetry={isOnline ? () => trendQuery.refetch() : undefined}
                retrying={trendQuery.isFetching}
                suppressStaleNotice={suppressStaleNotice}
            >
                <View style={styles.boundaryContent}>
                    <TrendTarget onPress={onPress}>
                        {heading}
                        <View
                            testID="weight-trend-preview-canvas"
                            style={previewStyle}
                            onLayout={(event) => {
                                const { width, height } = event.nativeEvent.layout;
                                setCanvasSize((current) => (
                                    current.width === width && current.height === height
                                        ? current
                                        : { width, height }
                                ));
                            }}
                        >
                            {suppressedEstimateMessage && (
                                <View style={styles.suppressedEstimate}>
                                    <Ionicons name="time-outline" size={22} color={theme.colors.onSurfaceVariant} />
                                    <AppText variant="muted" style={styles.suppressedEstimateText}>
                                        {suppressedEstimateMessage}
                                    </AppText>
                                </View>
                            )}
                            {!estimateIsSuppressed && points.length === 1 && (
                                <View style={styles.firstWeighIn}>
                                    <Ionicons name="scale-outline" size={22} color={theme.colors.primary} />
                                    <AppText variant="body">First weigh-in recorded</AppText>
                                </View>
                            )}
                            {!estimateIsSuppressed && points.length !== 1 && (
                                <WeightTrendChart
                                    accessibleChartSummary="Four-week underlying weight trend with scale readings and 95% estimated range"
                                    chartLayout={chartLayout}
                                    unit={user?.weight_unit}
                                    padding={axisPadding}
                                    axisFontSize={axisFontSize}
                                    selectedPoint={points[points.length - 1]}
                                />
                            )}
                        </View>
                    </TrendTarget>
                    {estimateIsOutdated && (
                        <FixedPageColumn
                            testID="trend-preview-recovery-action"
                            onLayout={event => setActionHeight(event.nativeEvent.layout.height)}
                        >
                            <AppButton
                                title="Log weight" variant="secondary"
                                leftIcon={<Ionicons name="scale-outline" size={18} color={theme.colors.primary} />}
                                onPress={onLogWeight}
                            />
                        </FixedPageColumn>
                    )}
                </View>
            </AsyncStateBoundary>
        </Slot>
    );
};

function TrendTarget({ onPress, children }: { onPress: () => void; children: React.ReactNode }) {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();
    const [hovered, setHovered] = useState(false);
    return <Pressable
        testID="weight-trend-preview-card"
        accessibilityRole="button"
        accessibilityLabel="Open full weight trend"
        accessibilityHint="Shows the interactive chart, confidence details, and time range controls"
        onPress={onPress}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => [styles.chartAction, hovered && styles.hovered, pressed && styles.pressed, focusVisible && styles.focusVisible]}
    ><FixedPageColumn style={styles.boundaryContent}>{children}</FixedPageColumn></Pressable>;
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
    flexSlot: { width: '100%', flex: 1, minHeight: 0 },
    errorSlot: { paddingTop: spacing.lg, paddingBottom: spacing.xs },
    expanded: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
    boundaryContent: { flex: 1, minHeight: 0, gap: spacing.sm },
    heading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    headingCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
    expandIcon: { width: theme.interaction.minimumTouchTarget, height: theme.interaction.minimumTouchTarget, alignItems: 'center', justifyContent: 'center' },
    // Include the space up to both page rules in the expansion target.
    chartAction: { flex: 1, minHeight: MIN_PREVIEW_HEIGHT, paddingTop: spacing.lg, paddingBottom: spacing.xs },
    hovered: { backgroundColor: theme.colors.surfaceHovered },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    focusVisible: { outlineWidth: theme.interaction.focusRingWidth, outlineColor: theme.colors.focusRing, outlineStyle: 'solid' },
    preview: { flex: 1, minHeight: MIN_PREVIEW_HEIGHT, alignItems: 'center', justifyContent: 'center' },
    previewExpanded: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', height: MIN_PREVIEW_HEIGHT },
    firstWeighIn: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    suppressedEstimate: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    suppressedEstimateText: { flex: 1 }
});
