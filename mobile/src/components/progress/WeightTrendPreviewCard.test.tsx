/** @file Regression coverage for Weight Trend Preview Card: WeightTrendPreviewCard. */

import { fireEvent, render } from '@testing-library/react-native';
import { Dimensions } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import Svg, { Text as SvgText } from 'react-native-svg';
import type { TrendMetricEntry, WeightTrendSummary } from '@calibrate/api-client';
import { WeightTrendCard } from '../WeightTrendCard';
import { WeightTrendChart } from '../WeightTrendChart';
import { WeightTrendPreviewCard } from './WeightTrendPreviewCard';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('@tanstack/react-query', () => ({
    ...jest.requireActual('@tanstack/react-query'),
    useQuery: jest.fn()
}));
jest.mock('../../auth/AuthContext', () => ({
    useAuth: () => ({
        api: { getTrendMetrics: jest.fn() },
        user: { weight_unit: 'LB' }
    })
}));

function metric(id: number, date: string, weight: number, trendWeight: number, materialized = true): TrendMetricEntry {
    return {
        id,
        user_id: 1,
        date,
        weight,
        body_fat_percent: null,
        trend_is_materialized: materialized,
        trend_weight: materialized ? trendWeight : weight,
        trend_ci_lower: materialized ? trendWeight - 0.4 : weight,
        trend_ci_upper: materialized ? trendWeight + 0.4 : weight,
        trend_std: materialized ? 0.2 : 0
    };
}

const METRICS = [
    metric(2, '2026-07-20', 168, 168.2),
    metric(1, '2026-07-19', 169, 168.8)
];

function trendSummary(overrides: Partial<WeightTrendSummary> = {}): WeightTrendSummary {
    return {
        status: 'provisional',
        evidence: 'provisional',
        freshness: 'current',
        model_version: 2,
        as_of_date: '2026-07-20',
        scope_start_date: '2026-06-22',
        scope_end_date: '2026-07-20',
        latest_observation_date: '2026-07-20',
        days_since_latest: 0,
        modeled_points: 2,
        observation_span_days: 1,
        segment_start_date: '2026-07-19',
        latest_trend: { weight: 168.2, lower: 167.8, upper: 168.6 },
        weekly_rate: null,
        short_term_variation: null,
        ...overrides
    };
}

describe('WeightTrendPreviewCard', () => {
    beforeEach(() => {
        Dimensions.set({
            window: { width: 390, height: 844, scale: 1, fontScale: 1 },
            screen: { width: 390, height: 844, scale: 1, fontScale: 1 }
        });
        (useQuery as jest.Mock).mockReturnValue({
            data: {
                metrics: METRICS,
                meta: {
                    weekly_rate: -0.35,
                    volatility: 'low',
                    total_points: 2,
                    total_span_days: 1,
                    trend_summary: trendSummary()
                }
            },
            error: null,
            isLoading: false, status: 'success'
        });
    });

    it('labels the current underlying trend with its as-of date and opens the full trend', () => {
        const onPress = jest.fn();
        const screen = render(<WeightTrendPreviewCard onPress={onPress} onLogWeight={jest.fn()} />);

        expect(screen.getByText('Trend')).toBeTruthy();
        expect(screen.queryByText('Weight trend')).toBeNull();
        expect(screen.queryByText('Last four weeks at a glance.')).toBeNull();
        expect(screen.queryByText('Smoothed weight')).toBeNull();
        expect(screen.getByText('168.2 lb underlying trend')).toBeTruthy();
        expect(screen.queryByLabelText('Latest smoothed weight 168.2 lb')).toBeNull();
        expect(screen.queryByText('95% estimated trend range')).toBeNull();
        expect(screen.queryByText('167.8 lb - 168.6 lb')).toBeNull();
        expect(screen.getByLabelText('Four-week underlying weight trend with scale readings and 95% estimated range')).toBeTruthy();
        expect(screen.queryByText(/Trend line:/)).toBeNull();
        expect(screen.queryByText(/-0\.35|volatility/)).toBeNull();
        expect(screen.queryByText(/^(Week|Month|Year|All)$/)).toBeNull();
        expect(screen.getAllByRole('button')).toHaveLength(1);
        expect(screen.queryByRole('button', { name: 'Weight trend details' })).toBeNull();

        fireEvent.press(screen.getByLabelText('Open full weight trend'));
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('fills its flexed preview immediately', () => {
        const screen = render(<WeightTrendPreviewCard onPress={jest.fn()} onLogWeight={jest.fn()} />);
        expect(screen.getByTestId('weight-trend-preview-canvas')).toHaveStyle({
            flex: 1,
            minHeight: 188
        });
        expect(screen.getByLabelText('Open full weight trend')).toHaveStyle({ paddingTop: 16, paddingBottom: 4 });
        expect(screen.getByLabelText('Four-week underlying weight trend with scale readings and 95% estimated range'))
            .toHaveProp('height', 188);
    });

    it('keeps a complete chart in the short-screen scrolling layout', () => {
        const screen = render(<WeightTrendPreviewCard expanded onPress={jest.fn()} onLogWeight={jest.fn()} />);
        expect(screen.getByTestId('weight-trend-preview-canvas')).toHaveStyle({ height: 188, flexShrink: 0, flexBasis: 'auto' });
        const axisLabels = screen.UNSAFE_getAllByType(SvgText);
        expect(axisLabels.every((label) => label.props.fontSize >= 12)).toBe(true);
    });

    it('reserves a larger chart and axis labels for native enlarged text', () => {
        Dimensions.set({
            window: { width: 390, height: 844, scale: 1, fontScale: 2 },
            screen: { width: 390, height: 844, scale: 1, fontScale: 2 }
        });
        const screen = render(<WeightTrendPreviewCard expanded onPress={jest.fn()} onLogWeight={jest.fn()} />);
        expect(screen.getByTestId('weight-trend-preview-canvas')).toHaveStyle({ height: 376 });
        expect(screen.UNSAFE_getAllByType(SvgText).every((label) => label.props.fontSize === 24)).toBe(true);
    });

    it('uses the same full visualization, axes, readings, and estimate band as the expanded chart', () => {
        const metrics = [
            metric(3, '2026-07-20', 168, 168.2),
            metric(2, '2026-07-19', 169, 168.8),
            metric(1, '2026-07-18', 170, 170, false)
        ];
        (useQuery as jest.Mock).mockReturnValue({
            data: {
                metrics,
                meta: { weekly_rate: -0.35, volatility: 'low', total_points: 3, total_span_days: 3 }
            },
            error: null,
            isLoading: false, status: 'success'
        });

        const screen = render(<WeightTrendPreviewCard onPress={jest.fn()} onLogWeight={jest.fn()} />);
        expect(screen.getAllByTestId('weight-trend-measurement')).toHaveLength(3);
        expect(screen.queryByLabelText('Chart legend')).toBeNull();
        const previewLayout = screen.UNSAFE_getByType(WeightTrendChart).props.chartLayout;
        const previewBand = screen.getByTestId('weight-trend-range-0').props;
        const expanded = render(<WeightTrendCard />);
        expect(expanded.getByLabelText('Chart legend')).toBeTruthy();
        expect(expanded.UNSAFE_getByType(WeightTrendChart).props.chartLayout).toEqual(previewLayout);
        const expandedBand = expanded.getByTestId('weight-trend-range-0').props;
        expect(previewBand.fill).toEqual(expandedBand.fill);
        expect(previewBand.stroke).toEqual(expandedBand.stroke);
        expect(screen.queryByText(/Trend line:/)).toBeNull();
    });

    it('labels a stale estimate by date without calling it current', () => {
        (useQuery as jest.Mock).mockReturnValue({
            data: {
                metrics: METRICS,
                meta: {
                    weekly_rate: -0.35,
                    volatility: 'low',
                    total_points: 2,
                    total_span_days: 1,
                    trend_summary: trendSummary({
                        status: 'stale',
                        freshness: 'stale',
                        latest_observation_date: '2026-07-12',
                        days_since_latest: 8
                    })
                }
            },
            error: null,
            isLoading: false, status: 'success'
        });

        const screen = render(
            <WeightTrendPreviewCard onPress={jest.fn()} onLogWeight={jest.fn()} />
        );

        expect(screen.getByText('Underlying trend: 168.2 lb | As of Jul 12')).toBeTruthy();
        expect(screen.queryByText(/Current underlying trend/)).toBeNull();
        expect(screen.getByLabelText('Four-week underlying weight trend with scale readings and 95% estimated range')).toBeTruthy();
        expect(screen.queryByLabelText('Log weight')).toBeNull();
    });

    it('budgets the outdated estimate recovery action and releases its space when fresh data arrives', () => {
        const onPress = jest.fn();
        const onLogWeight = jest.fn();
        const onMinimumHeightChange = jest.fn();
        (useQuery as jest.Mock).mockReturnValue({
            data: {
                metrics: [],
                meta: {
                    weekly_rate: -0.35,
                    volatility: 'low',
                    total_points: 2,
                    total_span_days: 19,
                    trend_summary: trendSummary({
                        status: 'stale',
                        freshness: 'outdated',
                        latest_observation_date: '2026-07-01',
                        days_since_latest: 19
                    })
                }
            },
            error: null,
            isLoading: false, status: 'success'
        });

        const screen = render(
            <WeightTrendPreviewCard onPress={onPress} onLogWeight={onLogWeight} onMinimumHeightChange={onMinimumHeightChange} />
        );

        expect(screen.getByText('Estimate out of date | Last scale weight Jul 1')).toBeTruthy();
        expect(screen.getByText(
            'Log a current scale weight to refresh the underlying trend estimate.'
        )).toBeTruthy();
        expect(screen.queryByText(/168\.2 lb/)).toBeNull();
        expect(screen.queryByLabelText('Four-week underlying weight trend with scale readings and 95% estimated range')).toBeNull();

        // The button needs its touch target and gap even before the first layout event.
        expect(onMinimumHeightChange).toHaveBeenLastCalledWith(322);
        fireEvent(screen.getByTestId('trend-preview-heading'), 'layout', {
            nativeEvent: { layout: { width: 358, height: 70 } }
        });
        expect(onMinimumHeightChange).toHaveBeenLastCalledWith(342);
        fireEvent(screen.getByTestId('trend-preview-recovery-action'), 'layout', {
            nativeEvent: { layout: { width: 358, height: 62 } }
        });
        expect(onMinimumHeightChange).toHaveBeenLastCalledWith(356);

        fireEvent.press(screen.getByLabelText('Log weight'));
        expect(onLogWeight).toHaveBeenCalledTimes(1);
        expect(onPress).not.toHaveBeenCalled();

        (useQuery as jest.Mock).mockReturnValue({
            data: { metrics: METRICS, meta: { total_points: 2, trend_summary: trendSummary() } },
            error: null, isLoading: false, status: 'success'
        });
        screen.rerender(<WeightTrendPreviewCard onPress={onPress} onLogWeight={onLogWeight} onMinimumHeightChange={onMinimumHeightChange} />);
        fireEvent(screen.getByTestId('trend-preview-heading'), 'layout', {
            nativeEvent: { layout: { width: 358, height: 50 } }
        });
        expect(screen.queryByLabelText('Log weight')).toBeNull();
        expect(onMinimumHeightChange).toHaveBeenLastCalledWith(266);
    });

    it('does not label an unavailable estimate as current', () => {
        (useQuery as jest.Mock).mockReturnValue({
            data: {
                metrics: METRICS,
                meta: {
                    weekly_rate: 0,
                    volatility: 'low',
                    total_points: 2,
                    total_span_days: 1,
                    trend_summary: trendSummary({
                        status: 'unavailable',
                        freshness: 'unavailable',
                        latest_trend: null
                    })
                }
            },
            error: null,
            isLoading: false, status: 'success'
        });

        const screen = render(
            <WeightTrendPreviewCard onPress={jest.fn()} onLogWeight={jest.fn()} />
        );

        expect(screen.getByText('Trend estimate temporarily unavailable')).toBeTruthy();
        expect(screen.getByText(
            'Your scale weights are saved, but the underlying trend estimate is temporarily unavailable.'
        )).toBeTruthy();
        expect(screen.queryByText(/Current underlying trend/)).toBeNull();
        expect(screen.queryByLabelText('Four-week underlying weight trend with scale readings and 95% estimated range')).toBeNull();
        expect(screen.queryByLabelText('Log weight')).toBeNull();
    });

    it('links an empty current period with existing history to the full trend', () => {
        const onPress = jest.fn();
        (useQuery as jest.Mock).mockReturnValue({
            data: {
                metrics: [],
                meta: { weekly_rate: 0, volatility: 'low', total_points: 4, total_span_days: 120 }
            },
            error: null,
            isLoading: false, status: 'success'
        });
        const screen = render(<WeightTrendPreviewCard onPress={onPress} onLogWeight={jest.fn()} />);
        expect(screen.getByText('No weigh-ins in the last four weeks. Open Details to view your history.')).toBeTruthy();
        fireEvent.press(screen.getByLabelText('Open full weight trend'));
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('draws against the measured canvas without stretching its markers', () => {
        const screen = render(<WeightTrendPreviewCard onPress={jest.fn()} onLogWeight={jest.fn()} />);
        fireEvent(
            screen.getByTestId('weight-trend-preview-canvas'),
            'layout',
            { nativeEvent: { layout: { width: 480, height: 320 } } }
        );
        const chart = screen.UNSAFE_getByType(Svg);
        expect(chart.props.viewBox).toBe('0 0 480 320');
        expect(chart.props.preserveAspectRatio).toBeUndefined();
    });
});
