/** @file metrics: Extracts the canonical local date from a metric wire date. */

import type { MetricEntry } from '@calibrate/api-client';

/** Extracts the canonical local date from a metric wire date. */
export function getMetricDate(metric: Pick<MetricEntry, 'date'>): string {
    return metric.date.split('T')[0] ?? metric.date;
}

/** Finds the latest metric by local date without mutating the input list. */
export function getLatestMetric<T extends Pick<MetricEntry, 'date'>>(
    metrics: ReadonlyArray<T> | null | undefined
): T | undefined {
    return metrics?.reduce<T | undefined>((latest, metric) => {
        if (!latest) return metric;
        return getMetricDate(metric) > getMetricDate(latest) ? metric : latest;
    }, undefined);
}
