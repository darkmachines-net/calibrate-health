/** @file weight Trend Source Revision: Fingerprint the exact raw observations that feed one materialized model snapshot. */

import { createHash } from 'node:crypto';

export type WeightTrendSourceMetric = {
    id: number;
    user_id: number;
    date: Date;
    weight_grams: number;
};

/** Fingerprint the exact raw observations that feed one materialized model snapshot. */
export function computeWeightTrendSourceRevision(metrics: readonly WeightTrendSourceMetric[]): string {
    const canonicalSource = metrics
        .slice()
        .sort((left, right) => left.date.getTime() - right.date.getTime() || left.id - right.id)
        .map((metric) => [metric.id, metric.user_id, metric.date.toISOString().slice(0, 10), metric.weight_grams]);
    return createHash('sha256')
        .update(JSON.stringify({ revision: 1, metrics: canonicalSource }))
        .digest('hex');
}
