/** @file Responsive weight trend chart with observation/interval geometry and accessible point selection. */

import React, { useMemo } from 'react';
import { Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Line, Path, Polygon, Text as SvgText, type SvgProps } from 'react-native-svg';
import type { TrendMetricEntry } from '@calibrate/api-client';
import { AppText } from './AppText';
import { radius, spacing, useAppTheme, type AppTheme } from '../theme';
import { formatWeight } from '../utils/format';
import {
    buildWeightTrendBandPoints,
    buildWeightTrendChartGeometry,
    buildWeightTrendLinePath,
    type WeightTrendChartGeometry,
    type WeightTrendChartPoint
} from '../weightTrend/geometry';

// Both sizes keep the same axis gutters, tick scale, and data styling.
const WEIGHT_TREND_CHART_PADDING = { left: 58, right: 12, top: 12, bottom: 32 };
const WEIGHT_TREND_AXIS_FONT_SIZE = 12;
// Preserve readable plots when the overview or detail controls require scrolling.
const DESKTOP_CHART_BREAKPOINT = 840;
const MOBILE_CHART_MIN_HEIGHT = 188;
const DESKTOP_CHART_MIN_HEIGHT = 260;
// Reserve two heading lines until the preview reports its measured heading height.
const PREVIEW_HEADING_HEIGHT = 50;
/** Selects the minimum full-chart height for phone or desktop viewports. */
export function getWeightTrendChartMinimumHeight(viewportWidth: number) {
    return viewportWidth >= DESKTOP_CHART_BREAKPOINT ? DESKTOP_CHART_MIN_HEIGHT : MOBILE_CHART_MIN_HEIGHT;
}
/** Reserves chart, heading, spacing, and optional action height for a stable preview layout. */
export function getWeightTrendPreviewMinimumHeight(viewportWidth: number, {
    chartScale = 1,
    headingHeight = PREVIEW_HEADING_HEIGHT,
    actionHeight = 0
}: { chartScale?: number; headingHeight?: number; actionHeight?: number } = {}) {
    const actionSpace = actionHeight > 0 ? actionHeight + spacing.sm : 0;
    return getWeightTrendChartMinimumHeight(viewportWidth) * chartScale
        + headingHeight + spacing.lg + spacing.sm + spacing.xs + actionSpace;
}

/** Measures effective native or browser text scaling to keep chart axes readable. */
export function useWeightTrendChartTypography() {
    const { width, fontScale } = useWindowDimensions();
    const [webAxisScale, setWebAxisScale] = React.useState(1);
    const probe = React.useRef<Text>(null);
    const readScale = React.useCallback(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return;
        const element = probe.current as unknown as HTMLElement | null;
        if (element) setWebAxisScale(Number.parseFloat(window.getComputedStyle(element).fontSize) / WEIGHT_TREND_AXIS_FONT_SIZE);
    }, []);
    React.useLayoutEffect(readScale, [readScale, width]);
    const axisScale = Math.max(1, fontScale, webAxisScale);
    const axisPadding = useMemo(() => ({
        ...WEIGHT_TREND_CHART_PADDING,
        left: WEIGHT_TREND_CHART_PADDING.left * axisScale,
        top: WEIGHT_TREND_CHART_PADDING.top * axisScale,
        bottom: WEIGHT_TREND_CHART_PADDING.bottom * axisScale
    }), [axisScale]);
    const axisProbe = Platform.OS === 'web' && <Text ref={probe} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        onLayout={readScale} style={probeStyle}>M</Text>;
    return { axisScale, axisPadding, axisFontSize: WEIGHT_TREND_AXIS_FONT_SIZE * axisScale, axisProbe };
}
const probeStyle = StyleSheet.create({ probe: { position: 'absolute', opacity: 0, pointerEvents: 'none', fontSize: WEIGHT_TREND_AXIS_FONT_SIZE } }).probe;
// Below this width, use endpoint dates so labels do not collide.
const THREE_DATE_TICKS_MIN_WIDTH = 320;
const MIN_CHART_WIDTH = 240;
const MIN_WEIGHT_AXIS_SPAN = 0.4;

type ChartLayoutOptions = {
    width: number;
    height: number;
    minHeight: number;
    padding?: typeof WEIGHT_TREND_CHART_PADDING;
    downsampleMeasurements?: boolean;
    modelStartDate?: string | null;
};

/** Builds chart geometry with shared padding, weight-span bounds, and text-scale-aware date ticks. */
export function buildWeightTrendVisualization(metrics: TrendMetricEntry[], options: ChartLayoutOptions) {
    const axisScale = (options.padding?.left ?? WEIGHT_TREND_CHART_PADDING.left) / WEIGHT_TREND_CHART_PADDING.left;
    return buildWeightTrendChartGeometry(metrics, {
        minWidth: MIN_CHART_WIDTH,
        minWeightSpan: MIN_WEIGHT_AXIS_SPAN,
        padding: WEIGHT_TREND_CHART_PADDING,
        // Drop the middle date before enlarged labels collide.
        xTickCount: options.width >= THREE_DATE_TICKS_MIN_WIDTH * axisScale ? 3 : 2,
        yAxisMode: 'nice',
        ...options
    });
}

function formatAxisDate(value: string, includeYear: boolean): string {
    const [yearString, monthString, dayString] = value.split('-');
    const date = new Date(Number(yearString), Number(monthString) - 1, Number(dayString));
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        ...(includeYear ? { year: '2-digit' as const } : {})
    }).format(date);
}

/** Map the chart summary to platform-safe SVG accessibility props. */
function getChartAccessibilityProps(accessibilityLabel: string): SvgProps {
    if (Platform.OS === 'web') return { 'aria-label': accessibilityLabel, role: 'img' };
    return {
        accessible: true,
        accessibilityRole: 'image',
        accessibilityLabel
    };
}

type WeightTrendChartProps = {
    chartLayout: WeightTrendChartGeometry;
    unit: Parameters<typeof formatWeight>[1];
    accessibleChartSummary: string;
    selectedPoint?: WeightTrendChartPoint | null;
    showModelBoundary?: boolean;
    padding?: typeof WEIGHT_TREND_CHART_PADDING;
    axisFontSize?: number;
};

/** Draws trend, observations, axes, and optional model boundaries from precomputed SVG geometry. */
export function WeightTrendChart({
    chartLayout, unit, accessibleChartSummary, selectedPoint,
    showModelBoundary = false,
    padding = WEIGHT_TREND_CHART_PADDING,
    axisFontSize = WEIGHT_TREND_AXIS_FONT_SIZE
}: WeightTrendChartProps) {
    const theme = useAppTheme();
    const includeYear = chartLayout.xTicks[0]?.dateKey.slice(0, 4) !== chartLayout.xTicks.at(-1)?.dateKey.slice(0, 4);
    return (
        <Svg
            style={StyleSheet.absoluteFill}
            testID="weight-trend-chart"
            fontFamily="sans-serif"
            {...getChartAccessibilityProps(accessibleChartSummary)}
            width="100%"
            height={chartLayout.height}
            viewBox={`0 0 ${chartLayout.width} ${chartLayout.height}`}
        >
            {chartLayout.yTicks.map((tick) => (
                <React.Fragment key={tick.value}>
                    <Line
                        x1={padding.left}
                        y1={tick.y}
                        x2={chartLayout.width - padding.right}
                        y2={tick.y}
                        stroke={theme.colors.outlineVariant}
                        strokeWidth={1}
                        strokeDasharray="3 4"
                    />
                    <SvgText
                        x={padding.left - 8}
                        y={tick.y + 4}
                        fill={theme.colors.onSurfaceVariant}
                        fontSize={axisFontSize}
                        textAnchor="end"
                    >
                        {formatWeight(tick.value, unit)}
                    </SvgText>
                </React.Fragment>
            ))}
            <Line
                x1={padding.left}
                y1={chartLayout.height - padding.bottom}
                x2={chartLayout.width - padding.right}
                y2={chartLayout.height - padding.bottom}
                stroke={theme.colors.outlineVariant}
                strokeWidth={1}
            />
            {showModelBoundary && chartLayout.modelBoundaryPoint && (
                <React.Fragment>
                    <Line
                        testID="weight-trend-model-boundary"
                        x1={chartLayout.modelBoundaryPoint.x}
                        y1={padding.top}
                        x2={chartLayout.modelBoundaryPoint.x}
                        y2={chartLayout.height - padding.bottom}
                        stroke={theme.colors.onSurfaceVariant}
                        strokeWidth={1.5}
                        strokeDasharray="5 4"
                    />
                    <SvgText
                        x={chartLayout.modelBoundaryPoint.x > chartLayout.width - 90
                            ? chartLayout.modelBoundaryPoint.x - 5
                            : chartLayout.modelBoundaryPoint.x + 5}
                        y={padding.top + 12}
                        fill={theme.colors.onSurfaceVariant}
                        fontSize={10}
                        textAnchor={chartLayout.modelBoundaryPoint.x > chartLayout.width - 90 ? 'end' : 'start'}
                    >
                        Trend starts
                    </SvgText>
                </React.Fragment>
            )}
            {chartLayout.trendSegments.map((segment, index) => (
                <React.Fragment key={`trend-segment-${index}`}>
                    {segment.length > 1 && (
                        <Polygon
                            testID={`weight-trend-range-${index}`}
                            points={buildWeightTrendBandPoints(segment)}
                            fill={theme.colors.infoContainer}
                            stroke={theme.colors.info}
                            strokeWidth={0.75}
                            opacity={0.72}
                        />
                    )}
                    <Path
                        testID={`weight-trend-smoothed-path-${index}`}
                        d={buildWeightTrendLinePath(segment)}
                        stroke={theme.colors.primary}
                        strokeWidth={4}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                    />
                </React.Fragment>
            ))}
            {chartLayout.measurementPoints.map((point) => (
                <Circle
                    key={`${point.metric.id}-${point.dateKey}`}
                    testID="weight-trend-measurement"
                    cx={point.x}
                    cy={point.measurementY}
                    r={3.5}
                    fill={theme.colors.surface}
                    stroke={theme.colors.info}
                    strokeWidth={1.5}
                />
            ))}
            {selectedPoint && (
                <Circle
                    cx={selectedPoint.x}
                    cy={selectedPoint.measurementY}
                    r={6}
                    fill={theme.colors.selectionContainer}
                    stroke={theme.colors.selection}
                    strokeWidth={2}
                />
            )}
            {chartLayout.xTicks.map((tick) => (
                <React.Fragment key={tick.key}>
                    <Line
                        x1={tick.x}
                        y1={chartLayout.height - padding.bottom}
                        x2={tick.x}
                        y2={chartLayout.height - padding.bottom + 4}
                        stroke={theme.colors.outlineVariant}
                        strokeWidth={1}
                    />
                    <SvgText
                        x={tick.x}
                        y={chartLayout.height - 6}
                        fill={theme.colors.onSurfaceVariant}
                        fontSize={axisFontSize}
                        textAnchor={tick.textAnchor}
                    >
                        {formatAxisDate(tick.dateKey, includeYear)}
                    </SvgText>
                </React.Fragment>
            ))}
        </Svg>
    );
}

/** Explains scale readings and the modeled weight trend with accessible legend labels. */
export const TrendChartLegend: React.FC = () => {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    return (
        <View accessible accessibilityLabel="Chart legend" style={styles.chartLegend}>
            <View style={styles.chartLegendItem}>
                <View style={styles.readingLegendMarker} />
                <AppText variant="caption">Scale reading</AppText>
            </View>
            <View style={styles.chartLegendItem}>
                <View style={styles.trendLegendMarker} />
                <AppText variant="caption">Underlying trend</AppText>
            </View>
            <View style={styles.chartLegendItem}>
                <View style={styles.rangeLegendMarker} />
                <AppText variant="caption">95% estimate range</AppText>
            </View>
        </View>
    );
};

const createStyles = (theme: AppTheme) => StyleSheet.create({
    chartLegend: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: spacing.md,
        paddingHorizontal: spacing.sm
    },
    chartLegendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    readingLegendMarker: {
        width: 10,
        height: 10,
        borderRadius: radius.pill,
        borderColor: theme.colors.info,
        borderWidth: 1.5,
        backgroundColor: theme.colors.surface
    },
    trendLegendMarker: {
        width: 20,
        height: 4,
        borderRadius: radius.pill,
        backgroundColor: theme.colors.primary
    },
    rangeLegendMarker: {
        width: 20,
        height: 10,
        borderRadius: radius.sm,
        borderColor: theme.colors.info,
        borderWidth: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.infoContainer
    },
});
