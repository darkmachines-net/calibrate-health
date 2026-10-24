/** @file Versioned weight-trend snapshot persistence, source-revision validation, and transactional recomputation. */

import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { diagnosticsRegistry } from '../observability';
import { addUtcDays, getSafeUtcTodayDateOnlyInTimeZone } from '../utils/date';
import { computeWeightTrend, WEIGHT_TREND_MODEL_VERSION } from './weightTrend';
import { computeWeightTrendSourceRevision } from './weightTrendSourceRevision';

export { computeWeightTrendSourceRevision } from './weightTrendSourceRevision';

const GRAMS_PER_KILOGRAM = 1000; // Canonical storage-to-model conversion for trend persistence.
const MATERIALIZATION_TRANSACTION_MAX_ATTEMPTS = 3; // A waiting RR lock may require a fresh post-conflict snapshot.
export const WEIGHT_TREND_ADVISORY_LOCK_NAMESPACE = 0x57544754; // WTGT isolates these per-user advisory locks.
export const MATERIALIZED_TREND_ACTIVE_HORIZON_DAYS = 120; // Keep trend modeling focused on recent weight behavior.
export const MATERIALIZED_TREND_WARMUP_DAYS = 30; // Extra context stabilizes the first active-window trend points.
export { WEIGHT_TREND_MODEL_VERSION };

export type WeightTrendMaterializationAvailability = 'available' | 'unavailable';

type TrendPersistenceClient = Pick<typeof prisma, '$transaction'>;
type TrendSnapshotClient = Pick<
    Prisma.TransactionClient,
    'bodyMetric' | 'bodyMetricTrend' | 'user' | '$queryRaw'
>;
type MetricHistoryRow = {
    id: number;
    user_id: number;
    date: Date;
    weight_grams: number;
};
type MaterializedTrendWindow = {
    activeStartDate: Date;
    modelStartDate: Date;
};

/**
 * Convert kilogram-domain model outputs to integer grams for persistence.
 */
function kilogramsToRoundedGrams(kilograms: number): number {
    return Math.round(kilograms * GRAMS_PER_KILOGRAM);
}

/** Convert a finite kilogram-per-day model rate to the floating-point grams/day persistence domain. */
function kilogramsPerDayToGramsPerDay(value: number | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value * GRAMS_PER_KILOGRAM : null;
}

/** Resolve today's date-only boundary in the account timezone unless a caller supplies an explicit as-of day. */
async function resolveTrendAsOfDate(
    userId: number,
    client: TrendSnapshotClient,
    explicitAsOfDate?: Date
): Promise<Date> {
    if (explicitAsOfDate) return explicitAsOfDate;

    const user = await client.user.findUnique({
        where: { id: userId },
        select: { timezone: true }
    });
    return getSafeUtcTodayDateOnlyInTimeZone(user?.timezone ?? 'UTC');
}

/**
 * Compute the active trend window and model warmup bounds from the latest metric date.
 */
export function getMaterializedTrendWindowFromLatestDate(latestMetricDate: Date): MaterializedTrendWindow {
    const activeStartDate = addUtcDays(latestMetricDate, -(MATERIALIZED_TREND_ACTIVE_HORIZON_DAYS - 1));
    const modelStartDate = addUtcDays(activeStartDate, -MATERIALIZED_TREND_WARMUP_DAYS);
    return { activeStartDate, modelStartDate };
}


/**
 * Load only the metrics needed to model the active trend horizon.
 */
async function loadMetricsForModelWindow(
    userId: number,
    modelStartDate: Date,
    asOfDate: Date,
    client: TrendSnapshotClient
): Promise<MetricHistoryRow[]> {
    return client.bodyMetric.findMany({
        where: {
            user_id: userId,
            date: { gte: modelStartDate, lte: asOfDate }
        },
        orderBy: { date: 'asc' },
        select: { id: true, user_id: true, date: true, weight_grams: true }
    });
}

/**
 * Fetch the newest metric date so recompute can anchor the active horizon.
 */
async function findLatestMetricDate(
    userId: number,
    asOfDate: Date,
    client: TrendSnapshotClient
): Promise<Date | null> {
    const latestMetric = await client.bodyMetric.findFirst({
        where: { user_id: userId, date: { lte: asOfDate } },
        orderBy: { date: 'desc' },
        select: { date: true }
    });
    return latestMetric?.date ?? null;
}

/**
 * Build persistence rows only for dates in the active trend horizon.
 */
function buildActiveTrendRows(
    metricsForModelWindow: MetricHistoryRow[],
    activeStartDate: Date,
    sourceRevision: string
): Array<{
    metric_id: number;
    user_id: number;
    date: Date;
    trend_weight_grams: number;
    trend_ci_lower_grams: number;
    trend_ci_upper_grams: number;
    trend_std_grams: number;
    trend_rate_grams_per_day: number | null;
    trend_rate_std_grams_per_day: number | null;
    model_version: number;
    source_revision: string;
}> {
    const trendResult = computeWeightTrend(
        metricsForModelWindow.map((metric) => ({
            date: metric.date,
            weight: metric.weight_grams / GRAMS_PER_KILOGRAM
        }))
    );

    type TrendPointV2 = (typeof trendResult.points)[number] & {
        trendRatePerDay?: number;
        trendRateStdPerDay?: number;
    };
    const trendByDateMs = new Map<number, TrendPointV2>();
    for (const point of trendResult.points) {
        trendByDateMs.set(point.date.getTime(), point);
    }

    return metricsForModelWindow.flatMap((metric) => {
        if (metric.date < activeStartDate) return [];
        const point = trendByDateMs.get(metric.date.getTime());
        if (!point) return [];
        return [
            {
                metric_id: metric.id,
                user_id: metric.user_id,
                date: metric.date,
                trend_weight_grams: kilogramsToRoundedGrams(point.trendWeight),
                trend_ci_lower_grams: kilogramsToRoundedGrams(point.lower95),
                trend_ci_upper_grams: kilogramsToRoundedGrams(point.upper95),
                trend_std_grams: kilogramsToRoundedGrams(point.trendStd),
                trend_rate_grams_per_day: kilogramsPerDayToGramsPerDay(point.trendRatePerDay),
                trend_rate_std_grams_per_day: kilogramsPerDayToGramsPerDay(point.trendRateStdPerDay),
                model_version: WEIGHT_TREND_MODEL_VERSION,
                source_revision: sourceRevision
            }
        ];
    });
}

function isRetryableMaterializationConflict(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) return false;
    const code = String(error.code);
    return code === 'P2002' || code === 'P2034' || code === '23505' || code === '40001' || code === '40P01';
}

/**
 * Recompute and replace one user's materialized weight trend rows from current BodyMetric history.
 */
export async function recomputeAndStoreUserWeightTrends(
    userId: number,
    client: TrendPersistenceClient = prisma,
    explicitAsOfDate?: Date
): Promise<void> {
    const startedAt = Date.now();
    let outcome: 'success' | 'failure' = 'failure';
    try {
        for (let attempt = 1; attempt <= MATERIALIZATION_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
            try {
                await client.$transaction(
                    async (tx) => {
                        // Serialize each user's replacements and keep every source read on one repeatable revision.
                        await tx.$queryRaw(
                            Prisma.sql`SELECT pg_advisory_xact_lock(${WEIGHT_TREND_ADVISORY_LOCK_NAMESPACE}::integer, ${userId}::integer)::text AS lock_result`
                        );

                        const asOfDate = await resolveTrendAsOfDate(userId, tx, explicitAsOfDate);
                        const latestMetricDate = await findLatestMetricDate(userId, asOfDate, tx);
                        if (!latestMetricDate) {
                            await tx.bodyMetricTrend.deleteMany({
                                where: { user_id: userId }
                            });
                            return;
                        }

                        const { activeStartDate, modelStartDate } =
                            getMaterializedTrendWindowFromLatestDate(latestMetricDate);
                        const metricsForModelWindow =
                            await loadMetricsForModelWindow(userId, modelStartDate, asOfDate, tx);
                        // Fit before touching persisted rows so model failures preserve the last-known-good snapshot.
                        const sourceRevision = computeWeightTrendSourceRevision(metricsForModelWindow);
                        const rows = buildActiveTrendRows(metricsForModelWindow, activeStartDate, sourceRevision);

                        await tx.bodyMetricTrend.deleteMany({
                            where: { user_id: userId }
                        });

                        if (rows.length > 0) {
                            await tx.bodyMetricTrend.createMany({ data: rows });
                        }
                    },
                    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
                );
                outcome = 'success';
                return;
            } catch (error) {
                const shouldRetry =
                    attempt < MATERIALIZATION_TRANSACTION_MAX_ATTEMPTS &&
                    isRetryableMaterializationConflict(error);
                if (!shouldRetry) throw error;
                // A waiter can pin its RR snapshot while blocked on the advisory lock. Retry the
                // whole transaction so lock acquisition and every source/replacement query are fresh.
            }
        }
    } finally {
        // Operational counters include only outcome and duration; raw weights never enter diagnostics.
        diagnosticsRegistry.recordOperation('weight_trend_recompute', outcome, Date.now() - startedAt);
    }
}

/**
 * Ensure active-horizon trend rows exist and match the active model version.
 */
export async function ensureMaterializedWeightTrends(
    userId: number,
    explicitAsOfDate?: Date
): Promise<WeightTrendMaterializationAvailability> {
    try {
        const asOfDate = await resolveTrendAsOfDate(userId, prisma, explicitAsOfDate);
        const latestMetric = await prisma.bodyMetric.findFirst({
            where: { user_id: userId, date: { lte: asOfDate } },
            orderBy: { date: 'desc' },
            select: { date: true }
        });
        if (!latestMetric) return 'available';

        const { activeStartDate, modelStartDate } = getMaterializedTrendWindowFromLatestDate(latestMetric.date);
        const metricsForModelWindow = await loadMetricsForModelWindow(userId, modelStartDate, asOfDate, prisma);
        const sourceRevision = computeWeightTrendSourceRevision(metricsForModelWindow);
        const staleOrMissing = await prisma.bodyMetric.findFirst({
            where: {
                user_id: userId,
                date: { gte: activeStartDate, lte: asOfDate },
                OR: [
                    { trend: { is: null } },
                    { trend: { is: { model_version: { not: WEIGHT_TREND_MODEL_VERSION } } } },
                    { trend: { is: { source_revision: null } } },
                    { trend: { is: { source_revision: { not: sourceRevision } } } }
                ]
            },
            select: { id: true }
        });

        if (!staleOrMissing) return 'available';
        await recomputeAndStoreUserWeightTrends(userId, prisma, asOfDate);
        return 'available';
    } catch {
        console.warn(
            `Unable to ensure materialized weight trends for user ${userId}. Return raw measurements with trend status unavailable, and check weight_trend_recompute diagnostics and database health if this persists.`
        );
        return 'unavailable';
    }
}

/**
 * Refresh trend rows after metric writes without blocking user data writes on transient failures.
 */
export async function refreshMaterializedWeightTrendsBestEffort(
    userId: number,
    explicitAsOfDate?: Date
): Promise<WeightTrendMaterializationAvailability> {
    try {
        await recomputeAndStoreUserWeightTrends(userId, prisma, explicitAsOfDate);
        return 'available';
    } catch {
        console.warn(
            `Unable to refresh materialized weight trends for user ${userId}; the last-known-good trend snapshot was preserved. Return raw measurements if a read-time refresh also fails, and check weight_trend_recompute diagnostics and database health if this persists.`
        );
        return 'unavailable';
    }
}
