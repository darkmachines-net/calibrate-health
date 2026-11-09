/** @file Keeps a fixed date viewport over independently cached weight history pages. */

import { useCallback, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { TrendMetricEntry, TrendMetricsResponse } from '@calibrate/api-client';
import { useAuth } from '../auth/AuthContext';
import { getTodayDate } from '../utils/dates';
import {
    weightHistoryDay,
    weightHistoryPage,
    weightHistoryPageIndex,
    type WeightHistoryRange
} from './historyWindow';

// Include neighbors of visible readings so a modeled line or interval can reach the plot edge.
const TREND_EDGE_CONTEXT_DAYS = 14;
// Cached pages stay warm while switching ranges or reversing a pan. Log mutations invalidate the prefix.
const HISTORY_PAGE_STALE_MS = 60_000;

function firstHistoryDay(data: TrendMetricsResponse | undefined, today: number): number {
    if (data?.meta.history_start_date) return weightHistoryDay(data.meta.history_start_date);
    if (!data?.meta.total_points || data.meta.history_start_date === null) return today;
    // Older servers omit explicit bounds; use the legacy history span if available.
    const latest = data.meta.trend_summary?.latest_observation_date ?? data.metrics[0]?.date;
    const last = latest ? weightHistoryDay(latest) : today;
    return last - Math.max(0, (data.meta.total_span_days || 1) - 1);
}

/** Loads the date pages intersecting the viewport, plus a page on either side as history allows. */
export function useWeightTrendHistory() {
    const { api, user } = useAuth();
    const todayDate = getTodayDate(user?.timezone);
    const today = weightHistoryDay(todayDate);
    const [range, setRange] = useState<WeightHistoryRange>(28);
    // Null follows today when the account date rolls over; historical dates stay anchored.
    const [requestedEnd, setRequestedEnd] = useState<number | null>(null);
    const pageOptions = (page: number) => ({
        queryKey: ['mobile-metrics-trend', 'page', todayDate, page],
        queryFn: () => api.getTrendMetrics({ ...weightHistoryPage(today, page), asOf: todayDate }),
        staleTime: HISTORY_PAGE_STALE_MS,
        refetchOnReconnect: 'always' as const
    });
    const head = useQuery(pageOptions(0));
    const earliest = firstHistoryDay(head.data, today);
    const oldestEnd = Math.min(today, earliest + range - 1);
    const end = Math.min(today, Math.max(oldestEnd, requestedEnd ?? today));
    const start = end - range + 1;
    const firstVisiblePage = weightHistoryPageIndex(today, Math.floor(end));
    const lastVisiblePage = weightHistoryPageIndex(today, Math.ceil(start));
    const lastPage = weightHistoryPageIndex(today, earliest);
    const firstPageToRead = Math.max(1, firstVisiblePage - 1);
    const lastPageToRead = Math.min(lastPage, lastVisiblePage + 1);
    const pageIndexes = Array.from(
        { length: Math.max(0, lastPageToRead - firstPageToRead + 1) },
        (_, index) => firstPageToRead + index
    );
    const pages = useQueries({ queries: pageIndexes.map(pageOptions) });
    const allPages = [head, ...pages];
    const visiblePages = [0, ...pageIndexes].flatMap((page, index) =>
        page >= firstVisiblePage && page <= lastVisiblePage ? [{ page, query: allPages[index] }] : []);
    const requiredPages = visiblePages.map(({ query }) => query);
    const missingWindows = visiblePages.flatMap(({ page, query }) => {
        if (query.data) return [];
        const bounds = weightHistoryPage(today, page);
        // The blank region extends halfway between the last loaded day and the first missing day.
        return [{ start: weightHistoryDay(bounds.start) - 0.5, end: weightHistoryDay(bounds.end) + 0.5 }];
    });
    const byDay = new Map<number, TrendMetricEntry>();
    for (const [index, { data }] of allPages.entries()) {
        const page = index === 0 ? 0 : pageIndexes[index - 1];
        for (const metric of data?.metrics ?? []) {
            const day = weightHistoryDay(metric.date);
            if (day <= today && weightHistoryPageIndex(today, day) === page &&
                day >= start - TREND_EDGE_CONTEXT_DAYS && day <= end + TREND_EDGE_CONTEXT_DAYS) {
                byDay.set(day, metric);
            }
        }
    }
    const metrics = [...byDay.values()];
    // Cached readings can stay on screen with a refresh notice even while a failed request is retrying.
    const failedPages = requiredPages.filter((page) => page.isError || (page.data && page.failureReason));
    const failedPage = failedPages[0];
    const loadingPage = requiredPages.some((page) => !page.data && page.isFetching);

    const panTo = useCallback((day: number) => {
        const next = Math.min(today, Math.max(oldestEnd, day));
        setRequestedEnd(next === today ? null : next);
    }, [oldestEnd, today]);

    function chooseRange(next: WeightHistoryRange) {
        // Commit the current end before changing its clamping bounds.
        setRequestedEnd(end === today ? null : Math.round(end));
        setRange(next);
    }

    return {
        range, chooseRange, start, end, today, oldestEnd, panTo,
        shiftWindow: (direction: -1 | 1) => panTo(Math.round(end) + direction * range),
        metrics,
        historyCount: head.data?.meta.total_points ?? 0,
        trendSummary: head.data?.meta.trend_summary,
        dataUpdatedAt: head.dataUpdatedAt,
        error: failedPage?.error ?? failedPage?.failureReason ?? null,
        errorUpdatedAt: failedPage?.errorUpdatedAt ?? 0,
        missingWindows,
        loadingPage,
        isFetching: requiredPages.some((page) => page.isFetching),
        retry: () => Promise.all(failedPages.map((page) => page.refetch()))
    };
}
