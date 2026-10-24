/** @file Regression coverage for Weight Trend Card: WeightTrendCard. */

import { fireEvent, render, within } from '@testing-library/react-native';
import { Dimensions, Platform, StyleSheet } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { TrendMetricEntry, TrendMetricsResponse, WeightTrendSummary } from '@calibrate/api-client';
import {
    getWeightTrendChartMinimumHeight,
    WeightTrendCard
} from './WeightTrendCard';
import { spacing } from '../theme';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('@tanstack/react-query', () => ({
    ...jest.requireActual('@tanstack/react-query'),
    useQuery: jest.fn()
}));
jest.mock('../auth/AuthContext', () => ({
    useAuth: () => ({
        api: { getTrendMetrics: jest.fn() },
        user: { weight_unit: 'LB' }
    })
}));

const METRICS: TrendMetricEntry[] = [
    createMetric(3, '2026-07-15', 168.3),
    createMetric(2, '2026-07-14', 168.7),
    createMetric(1, '2026-07-13', 169.8)
];

function createMetric(id: number, date: string, weight: number): TrendMetricEntry {
    return {
        id,
        user_id: 1,
        date,
        weight,
        body_fat_percent: null,
        trend_is_materialized: true,
        trend_weight: 168.2,
        trend_ci_lower: 167.1,
        trend_ci_upper: 169.3,
        trend_std: 0.4
    };
}

function createTrendSummary(): WeightTrendSummary {
    return {
        status: 'sufficient',
        evidence: 'sufficient',
        freshness: 'current',
        model_version: 2,
        as_of_date: '2026-07-15',
        scope_start_date: '2026-06-17',
        scope_end_date: '2026-07-15',
        latest_observation_date: '2026-07-15',
        days_since_latest: 0,
        modeled_points: 3,
        observation_span_days: 2,
        segment_start_date: '2026-07-13',
        interval_kind: 'latent_weight_model_uncertainty',
        confidence_level: 0.95,
        latest_trend: { weight: 168.2, lower: 167.1, upper: 169.3 },
        weekly_rate: {
            estimate: -0.3,
            lower: -0.6,
            upper: 0,
            point_count: 3,
            span_days: 2,
            evidence: 'provisional'
        },
        short_term_variation: {
            standard_deviation: 0.5,
            central_80_half_width: 0.6
        }
    };
}

function response(metrics = METRICS, summary: WeightTrendSummary | null = createTrendSummary()): TrendMetricsResponse {
    return {
        metrics,
        meta: {
            weekly_rate: 0.19,
            volatility: 'low',
            total_points: metrics.length,
            total_span_days: 2,
            ...(summary ? { trend_summary: summary } : {})
        }
    };
}

describe('WeightTrendCard', () => {
    beforeEach(() => {
        Dimensions.set({ window: { width: 390, height: 844, scale: 1, fontScale: 1 }, screen: { width: 390, height: 844, scale: 1, fontScale: 1 } });
        (useQuery as jest.Mock).mockReturnValue({ data: response(), error: null, isLoading: false, status: 'success' });
    });

    it('uses the screen pane directly instead of adding a second card surface', () => {
        const screen = render(<WeightTrendCard testID="weight-trend-content" />);
        const style = StyleSheet.flatten(screen.getByTestId('weight-trend-content').props.style);

        expect(style).toEqual(expect.objectContaining({ width: '100%', gap: spacing.md }));
        expect(style).not.toHaveProperty('padding');
        expect(style).not.toHaveProperty('borderRadius');
        expect(style).not.toHaveProperty('backgroundColor');
    });

    it('defaults the consolidated summary to the latest point and selects from web offset coordinates', () => {
        const screen = render(<WeightTrendCard />);
        const chart = screen.getByLabelText('Select nearest weigh-in');

        const initialSummary = within(screen.getByTestId('selected-trend-summary'));
        expect(initialSummary.getByText('Jul 15, 2026')).toBeTruthy();
        expect(initialSummary.getByText('Underlying weight estimate')).toBeTruthy();
        expect(initialSummary.getByText('Scale reading')).toBeTruthy();
        expect(initialSummary.getByText('168.3 lb')).toBeTruthy();
        expect(initialSummary.queryByLabelText('Previous weigh-in')).toBeNull();
        expect(screen.getByLabelText('Selected weigh-in navigation')).toBeTruthy();
        expect(screen.getByLabelText('Chart legend')).toBeTruthy();
        expect(screen.getAllByText('Scale reading')).toHaveLength(2);
        expect(screen.getByText('Underlying trend')).toBeTruthy();
        expect(screen.getByText('95% estimate range')).toBeTruthy();
        fireEvent.press(chart, { nativeEvent: { offsetX: 170 } });
        expect(screen.getByText('Jul 14, 2026')).toBeTruthy();
        fireEvent.press(chart, { nativeEvent: { offsetX: 18 } });
        expect(screen.getByText('Jul 13, 2026')).toBeTruthy();
    });

    it('provides accessible previous and next point navigation', () => {
        const screen = render(<WeightTrendCard />);
        const previous = screen.getByLabelText('Previous weigh-in');
        const next = screen.getByLabelText('Next weigh-in');

        expect(next).toHaveProp('accessibilityState', { disabled: true });
        fireEvent.press(previous);
        expect(screen.getByText('Jul 14, 2026')).toBeTruthy();
        expect(screen.getByTestId('weight-trend-selection-announcement').props.children).toContain(
            'Selected Jul 14, 2026'
        );
        expect(screen.getByLabelText('Next weigh-in')).toHaveProp('accessibilityState', { disabled: false });
        fireEvent.press(screen.getByLabelText('Previous weigh-in'));
        expect(screen.getByText('Jul 13, 2026')).toBeTruthy();
        expect(screen.getByLabelText('Previous weigh-in')).toHaveProp('accessibilityState', { disabled: true });
    });

    it('supports Left, Right, Home, and End from the chart focus target', () => {
        const screen = render(<WeightTrendCard />);
        const chart = screen.getByLabelText('Select nearest weigh-in');
        const preventDefault = jest.fn();

        fireEvent(chart, 'keyDown', { key: 'ArrowLeft', preventDefault });
        expect(screen.getByText('Jul 14, 2026')).toBeTruthy();
        fireEvent(chart, 'keyDown', { key: 'Home', preventDefault });
        expect(screen.getByText('Jul 13, 2026')).toBeTruthy();
        fireEvent(chart, 'keyDown', { key: 'ArrowRight', preventDefault });
        expect(screen.getByText('Jul 14, 2026')).toBeTruthy();
        fireEvent(chart, 'keyDown', { key: 'End', preventDefault });
        expect(screen.getByText('Jul 15, 2026')).toBeTruthy();
        expect(screen.getByTestId('weight-trend-selection-announcement').props.children).toContain(
            'Selected Jul 15, 2026'
        );
        expect(preventDefault).toHaveBeenCalledTimes(4);
    });

    it('keeps the current selection when a press has no usable coordinate', () => {
        const screen = render(<WeightTrendCard />);
        fireEvent.press(screen.getByLabelText('Select nearest weigh-in'), { nativeEvent: {} });
        expect(within(screen.getByTestId('selected-trend-summary')).getByText('Jul 15, 2026')).toBeTruthy();
    });

    it('renders the first-weigh-in state for a single metric', () => {
        (useQuery as jest.Mock).mockReturnValue({
            data: response([METRICS[0]], null),
            error: null,
            isLoading: false, status: 'success'
        });
        const screen = render(<WeightTrendCard />);
        expect(screen.getByText('First weigh-in recorded')).toBeTruthy();
        expect(screen.getByText('168.3 lb on Jul 15, 2026')).toBeTruthy();
    });

    it('draws raw measurements as dots and segments only the modeled trend', () => {
        const metrics = [
            { ...createMetric(4, '2026-07-25', 168.3), trend_weight: 168.2 },
            { ...createMetric(3, '2026-07-24', 168.7), trend_weight: 168.8 },
            { ...createMetric(2, '2026-07-01', 169.2), trend_weight: 169.1 },
            { ...createMetric(1, '2026-06-30', 169.8), trend_weight: 169.4 }
        ];
        (useQuery as jest.Mock).mockReturnValue({ data: response(metrics, null), error: null, isLoading: false, status: 'success' });

        const screen = render(<WeightTrendCard />);
        expect(screen.queryByTestId('weight-trend-measurement-path')).toBeNull();
        expect(screen.getByTestId('weight-trend-smoothed-path-0')).toBeTruthy();
        expect(screen.getByTestId('weight-trend-smoothed-path-1')).toBeTruthy();
        expect(screen.getByTestId('weight-trend-range-0')).toBeTruthy();
        expect(screen.getByTestId('weight-trend-range-1')).toBeTruthy();
    });

    it('shows old context as measurement-only and marks the model boundary for Year and All', () => {
        const metrics = [
            createMetric(3, '2026-07-15', 168.3),
            createMetric(2, '2026-07-14', 168.7),
            {
                ...createMetric(1, '2026-01-01', 176),
                trend_is_materialized: false,
                trend_weight: 176,
                trend_ci_lower: 176,
                trend_ci_upper: 176,
                trend_std: 0
            }
        ];
        (useQuery as jest.Mock).mockReturnValue({ data: response(metrics, null), error: null, isLoading: false, status: 'success' });
        const screen = render(<WeightTrendCard />);

        fireEvent.press(screen.getByText('All'));
        expect(screen.getByTestId('weight-trend-model-boundary')).toBeTruthy();
        expect(screen.getByText(/Earlier dots are measurements only/)).toBeTruthy();

        fireEvent.press(screen.getByLabelText('Previous weigh-in'));
        fireEvent.press(screen.getByLabelText('Previous weigh-in'));
        const details = within(screen.getByTestId('selected-trend-summary'));
        expect(details.getByText('Scale reading')).toBeTruthy();
        expect(details.getByText(/no underlying trend estimate/)).toBeTruthy();
        expect(details.queryByText('Underlying weight estimate')).toBeNull();
        expect(details.queryByText(/95% trend range/)).toBeNull();
    });

    it('focuses on the underlying estimate and keeps concise context below the chart', () => {
        const screen = render(<WeightTrendCard />);
        expect(screen.getAllByText('168.2 lb').length).toBeGreaterThan(0);
        expect(screen.queryByText('Smoothed weight')).toBeNull();
        const summary = within(screen.getByTestId('selected-trend-summary'));
        expect(summary.getByText('Underlying weight estimate')).toBeTruthy();
        expect(summary.getByText('Scale reading')).toBeTruthy();
        expect(summary.getByText('168.3 lb')).toBeTruthy();
        expect(summary.getByText(/95% trend range/)).toBeTruthy();
        expect(screen.queryByText(/uncertainty in the estimate/)).toBeNull();
        const rangeHelp = screen.getByLabelText('About the 95% trend range');
        fireEvent(rangeHelp, 'hoverIn');
        expect(screen.getByText(/uncertainty in the estimate/)).toBeTruthy();
        expect(screen.getByTestId('trend-range-tooltip')).toHaveStyle({ position: 'absolute' });
        fireEvent(rangeHelp, 'hoverOut');
        expect(screen.queryByText(/uncertainty in the estimate/)).toBeNull();
        fireEvent(rangeHelp, 'focus');
        expect(screen.getByTestId('trend-range-tooltip')).toHaveProp('role', 'tooltip');
        fireEvent(rangeHelp, 'blur');
        expect(screen.queryByTestId('trend-range-tooltip')).toBeNull();
        fireEvent.press(rangeHelp);
        expect(screen.getByTestId('trend-range-tooltip')).toHaveStyle({ position: 'absolute' });
        fireEvent.press(rangeHelp);
        expect(screen.queryByTestId('trend-range-tooltip')).toBeNull();
        expect(screen.queryByText('Scale reading variation')).toBeNull();
        expect(screen.queryByText('About 80% within +/- 0.6 lb')).toBeNull();
        expect(screen.queryByText('Hydration, meals, timing, and scale noise can shift individual readings.')).toBeNull();
        expect(screen.queryByText('Current pace estimate')).toBeNull();
        expect(screen.queryByText('Down 0.3 lb/week')).toBeNull();
        expect(screen.queryByText(/0\.19|low volatility/)).toBeNull();
    });

    it('preserves a useful snapshot for legacy payloads', () => {
        (useQuery as jest.Mock).mockReturnValue({ data: response(METRICS, null), error: null, isLoading: false, status: 'success' });
        const screen = render(<WeightTrendCard />);
        expect(screen.getAllByText('168.2 lb').length).toBeGreaterThan(0);
        expect(screen.queryByText('Scale reading variation')).toBeNull();
        expect(screen.queryByText('Current pace estimate')).toBeNull();
        expect(screen.getByText('Trend line: steady over 2 days.')).toBeTruthy();
    });

    it('keeps raw readings usable and labels trend fitting as unavailable', () => {
        const summary: WeightTrendSummary = {
            ...createTrendSummary(),
            status: 'unavailable',
            evidence: 'insufficient',
            freshness: 'unavailable',
            model_version: null,
            modeled_start_date: null,
            modeled_observations: 0,
            returned_modeled_points: 0,
            modeled_points: 0,
            observation_span_days: 0,
            segment_start_date: null,
            latest_trend: null,
            weekly_rate: null,
            short_term_variation: null
        };
        const rawMetrics = METRICS.map((metric) => ({
            ...metric,
            trend_is_materialized: false,
            trend_weight: metric.weight,
            trend_ci_lower: metric.weight,
            trend_ci_upper: metric.weight,
            trend_std: 0
        }));
        (useQuery as jest.Mock).mockReturnValue({
            data: response(rawMetrics, summary),
            error: null,
            isLoading: false,
            status: 'success'
        });

        const screen = render(<WeightTrendCard />);
        expect(screen.getByTestId('weight-trend-unavailable')).toHaveProp('accessibilityRole', 'alert');
        expect(screen.getByText('Trend estimate temporarily unavailable')).toBeTruthy();
        expect(screen.getByText('Your scale readings are still shown. Try again later for the underlying trend.')).toBeTruthy();
        expect(screen.queryByTestId('weight-trend-smoothed-path-0')).toBeNull();
        expect(screen.getByText('Underlying trend')).toBeTruthy();
        expect(screen.getByText('95% estimate range')).toBeTruthy();

        const selected = within(screen.getByTestId('selected-trend-summary'));
        expect(selected.getByText('168.3 lb')).toBeTruthy();
        expect(selected.getByText(
            'The underlying trend is temporarily unavailable, but this scale reading is saved.'
        )).toBeTruthy();
    });

    it('shows estimate freshness without adding pace information', () => {
        const summary = createTrendSummary();
        summary.freshness = 'outdated';
        summary.days_since_latest = 18;
        (useQuery as jest.Mock).mockReturnValue({ data: response(METRICS, summary), error: null, isLoading: false, status: 'success' });

        const screen = render(<WeightTrendCard />);
        expect(screen.getByText('Current weigh-in needed')).toBeTruthy();
        expect(screen.queryByText('Current pace estimate')).toBeNull();
    });

    it('distinguishes an empty selected range from a user with no weight history', () => {
        (useQuery as jest.Mock).mockReturnValue({
            data: {
                metrics: [],
                meta: { weekly_rate: 0, volatility: 'low', total_points: 4, total_span_days: 120 }
            },
            error: null,
            isLoading: false, status: 'success'
        });
        const screen = render(<WeightTrendCard />);
        expect(screen.getByText('No weigh-ins in this range. Choose All to view your weight history.')).toBeTruthy();
        fireEvent.press(screen.getByText('All'));
        expect(useQuery).toHaveBeenLastCalledWith(expect.objectContaining({
            queryKey: ['mobile-metrics-trend', 'all']
        }));
    });

    it('exposes the dynamic chart as one named image', () => {
        const platform = jest.replaceProperty(Platform, 'OS', 'ios');
        try {
            const screen = render(<WeightTrendCard />);
            const chart = screen.getByTestId('weight-trend-chart');
            expect(chart).toHaveProp('accessibilityRole', 'image');
            expect(chart.props.accessibilityLabel).toContain('Weight chart from Jul 13, 2026 to Jul 15, 2026');
            expect(screen.queryByLabelText('170 lb weight axis label')).toBeNull();
            expect(screen.queryByLabelText('Jul 15 date axis label')).toBeNull();
            expect(screen.getByLabelText('Chart legend')).toBeTruthy();
            expect(screen.queryByText('Current pace estimate')).toBeNull();
        } finally {
            platform.restore();
        }
    });

    it('uses DOM-safe accessibility props for the web chart', () => {
        const platform = jest.replaceProperty(Platform, 'OS', 'web');
        try {
            const chart = render(<WeightTrendCard />).getByTestId('weight-trend-chart');
            expect(chart.props).toEqual(expect.objectContaining({
                'aria-label': expect.stringContaining('Weight chart from Jul 13, 2026 to Jul 15, 2026'),
                role: 'img'
            }));
            expect(chart.props).not.toHaveProperty('accessible');
            expect(chart.props).not.toHaveProperty('accessibilityLabel');
            expect(chart.props).not.toHaveProperty('accessibilityRole');
        } finally {
            platform.restore();
        }
    });

    it('does not expose the raw chart data table', () => {
        const screen = render(<WeightTrendCard />);
        expect(screen.queryByLabelText('View data table')).toBeNull();
        expect(screen.queryByTestId('weight-trend-data-table')).toBeNull();
    });

    it('preserves the minimum plot height and grows to all available space', () => {
        const screen = render(<WeightTrendCard />);
        const canvas = screen.getByTestId('weight-trend-chart-canvas');
        fireEvent(canvas, 'layout', { nativeEvent: { layout: { width: 340, height: 100 } } });
        expect(screen.getByTestId('weight-trend-chart')).toHaveProp('height', 188);
        fireEvent(canvas, 'layout', { nativeEvent: { layout: { width: 340, height: 600 } } });
        expect(screen.getByTestId('weight-trend-chart')).toHaveProp('height', 600);
        fireEvent(canvas, 'layout', { nativeEvent: { layout: { width: 340, height: 240 } } });
        expect(screen.getByTestId('weight-trend-chart')).toHaveProp('height', 240);
    });

    it('uses a legible minimum on desktop', () => {
        expect(getWeightTrendChartMinimumHeight(1_024)).toBe(260);
    });
});
