/** @file Derives goal decisions from bounded, account-local trend evidence and records directional achievement. */
import { createHash } from 'node:crypto';
import type { Goal } from '@prisma/client';
import { assessMaintenanceRange, GOAL_TREND_MAX_AGE_DAYS, reachesGoal } from '../../../shared/goalAssessment';
import { MS_PER_DAY, getSafeUtcTodayDateOnlyInTimeZone } from '../utils/date';
import { computeWeightTrend, WEIGHT_TREND_MODEL_VERSION } from './weightTrend';
import { getMaterializedTrendWindowFromLatestDate } from './materializedWeightTrend';
import { computeWeightTrendSourceRevision } from './weightTrendSourceRevision';
import { recordSyncChange, type MutationDatabase } from './clientOperations';

/** Fit the same model/window as the weight chart, directly from the transaction's current weight rows. */
export async function readGoalTrend(tx: MutationDatabase, userId: number, asOf: Date) {
    const latest = await tx.bodyMetric.findFirst({
        where: { user_id: userId, date: { lte: asOf } }, orderBy: { date: 'desc' }, select: { date: true }
    });
    if (!latest) return { evidence: 'insufficient' as const, trend: null, revision: null };
    const { modelStartDate } = getMaterializedTrendWindowFromLatestDate(latest.date);
    const rows = await tx.bodyMetric.findMany({
        where: { user_id: userId, date: { gte: modelStartDate, lte: asOf } }, orderBy: { date: 'asc' },
        select: { id: true, user_id: true, date: true, weight_grams: true }
    });
    const revision = createHash('sha256').update(`${WEIGHT_TREND_MODEL_VERSION}:${computeWeightTrendSourceRevision(rows)}`).digest('hex');
    if (WEIGHT_TREND_MODEL_VERSION !== 2) return { evidence: 'unavailable' as const, trend: null, revision };
    let model;
    try {
        model = computeWeightTrend(rows.map(row => ({ date: row.date, weight: row.weight_grams / 1000 })), { asOfDate: asOf });
    } catch {
        return { evidence: 'unavailable' as const, trend: null, revision };
    }
    const point = model.points.at(-1);
    if (!point) return { evidence: 'unavailable' as const, trend: null, revision };
    const trend = {
        date: point.date.toISOString().slice(0, 10),
        weight_grams: Math.round(point.trendWeight * 1000),
        lower_grams: Math.round(point.lower95 * 1000),
        upper_grams: Math.round(point.upper95 * 1000)
    };
    if ((asOf.getTime() - point.date.getTime()) / MS_PER_DAY > GOAL_TREND_MAX_AGE_DAYS) {
        return { evidence: 'stale' as const, trend, revision };
    }
    return { evidence: model.evidence.status === 'sufficient' ? 'current' as const : 'insufficient' as const, trend, revision };
}

/** Describe the active maintenance range even when food tracking or calorie planning is paused. */
export function maintenanceAssessment(goal: Pick<Goal, 'maintenance_lower_grams' | 'maintenance_upper_grams' | 'target_weight_grams'>,
    evidence: Awaited<ReturnType<typeof readGoalTrend>>) {
    if (goal.maintenance_lower_grams == null || goal.maintenance_upper_grams == null) return 'range_required' as const;
    if (evidence.evidence !== 'current' || !evidence.trend) return evidence.evidence === 'current' ? 'unavailable' as const : evidence.evidence;
    return assessMaintenanceRange(evidence.trend.weight_grams, {
        target_weight_grams: goal.target_weight_grams,
        lower_weight_grams: goal.maintenance_lower_grams,
        upper_weight_grams: goal.maintenance_upper_grams
    });
}

/** Record or revalidate active achievement under the planning lock, preserving it across later fluctuations. */
export async function reconcileGoalCompletion(
    tx: MutationDatabase, goal: Goal, today: Date, timezone: string,
    evidence: Awaited<ReturnType<typeof readGoalTrend>>, operationId?: string, historicalOnly = false
) {
    if (goal.daily_deficit === 0 || evidence.evidence === 'unavailable') return goal;
    let completedOn = goal.completed_on;
    let sourceRevision = goal.completion_source_revision;
    if (completedOn) {
        const historical = historicalOnly || evidence.trend?.date === completedOn.toISOString().slice(0, 10)
            ? evidence : await readGoalTrend(tx, goal.user_id, completedOn);
        if (historical.revision !== sourceRevision && historical.evidence !== 'unavailable') {
            const date = completedOn.toISOString().slice(0, 10);
            if (historical.evidence === 'current' && historical.trend?.date === date &&
                reachesGoal(historical.trend.weight_grams, goal.target_weight_grams, goal.daily_deficit)) {
                sourceRevision = historical.revision;
            } else {
                completedOn = null;
                sourceRevision = null;
            }
        }
    }
    if (!historicalOnly && !completedOn && evidence.evidence === 'current' && evidence.trend) {
        const date = new Date(`${evidence.trend.date}T00:00:00.000Z`);
        if (date <= today && date >= getSafeUtcTodayDateOnlyInTimeZone(timezone, goal.created_at) &&
            reachesGoal(evidence.trend.weight_grams, goal.target_weight_grams, goal.daily_deficit)) {
            completedOn = date;
            sourceRevision = evidence.revision;
        }
    }
    if (completedOn?.getTime() === goal.completed_on?.getTime() && sourceRevision === goal.completion_source_revision) return goal;
    const updated = await tx.goal.update({ where: { id: goal.id }, data: {
        completed_on: completedOn, completion_source_revision: sourceRevision
    } });
    if (completedOn) {
        await tx.calibrationRecommendation.updateMany({
            where: { user_id: goal.user_id, source_goal_id: goal.id, status: 'PENDING' }, data: { status: 'STALE' }
        });
    }
    await recordSyncChange({ tx, userId: goal.user_id, entityType: 'goal', entityId: goal.id, action: 'upsert', operationId, payload: updated });
    return updated;
}

/** Refresh the current goal and revalidate affected completions without changing the active goal selection. */
export async function reconcileGoalsAfterWeight(
    tx: MutationDatabase, userId: number, timezone: string, today: Date, operationId?: string, earliestChangedDate?: Date
) {
    const goal = await tx.goal.findFirst({ where: { user_id: userId }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }] });
    if (goal?.predecessor_goal_id != null) {
        const previous = await tx.goal.findMany({
            where: { user_id: userId, id: { not: goal.id }, completed_on: { not: null, gte: earliestChangedDate } }
        });
        for (const candidate of previous) {
            const date = candidate.completed_on!;
            const evidence = await readGoalTrend(tx, userId, date);
            await reconcileGoalCompletion(tx, candidate, date, timezone, evidence, operationId, true);
        }
    }
    if (!goal || goal.daily_deficit === 0) return null;
    const resolved = await reconcileGoalCompletion(tx, goal, today, timezone, await readGoalTrend(tx, userId, today), operationId);
    return !goal.completed_on && resolved.completed_on ? { goal_id: goal.id, completed_on: resolved.completed_on.toISOString().slice(0, 10) } : null;
}
