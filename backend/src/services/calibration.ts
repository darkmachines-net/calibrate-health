/** @file Legacy calibration compatibility: read accepted revisions and undo future changes; new recommendations are retired. */

import { Prisma } from '@prisma/client';
import { CALIBRATION_ASSESSMENT_VERSION, CALIBRATION_MIN_TARGET_KCAL, CALIBRATION_MODEL_VERSION, type CalibrationResult } from '../../../shared/calibration';
import type { CaloriePlanReasonCode, CaloriePlanStatus } from '../../../shared/caloriePolicy';
import prisma from '../config/database';
import { buildStoredCaloriePlanningSnapshot } from './caloriePlanning';
import { lockCaloriePlanningInputs } from './caloriePlanningLock';
import { observeCurrentCaloriePlan } from './dailyCaloriePlans';
import { addUtcDays, getSafeUtcTodayDateOnlyInTimeZone } from '../utils/date';
import { executeIdempotentMutation, recordSyncChange } from './clientOperations';

type MaterializedRecommendation = {
    id: number;
    status: 'pending';
    inputFingerprint: string;
    effectiveLocalDate: string;
};

export type ScheduledCalibrationChange = {
    recommendationId: number | null;
    targetAdjustmentKcal: number;
    dailyCalorieBudgetKcal: number | null;
    effectiveLocalDate: string;
};

export type CalibrationStatus = {
    generatedAt: string;
    inputFingerprint: string | null;
    evaluation: CalibrationResult;
    recommendation: MaterializedRecommendation | null;
    scheduledChange: ScheduledCalibrationChange | null;
    planStatus: CaloriePlanStatus;
    planReasonCode: CaloriePlanReasonCode | null;
};

export class CalibrationConflictError extends Error {
    /** Identify a stale calibration decision that callers must refresh before another apply or undo attempt. */
    constructor(message: string) {
        super(message);
        this.name = 'CalibrationConflictError';
    }
}

function toDateKey(date: Date): string { return date.toISOString().slice(0, 10); }

function buildUnavailableEvaluation(options: {
    asOfDate: string;
    headline: string;
    summary: string;
    missingCriteria: string[];
    weightUnit: 'KG' | 'LB';
    configuredDailyDeficitKcal?: number;
    blocker?: 'plan_unavailable' | 'trend_unavailable';
}): CalibrationResult {
    return {
        modelVersion: CALIBRATION_MODEL_VERSION,
        asOfDate: options.asOfDate,
        weightUnit: options.weightUnit,
        status: 'not_ready',
        headline: options.headline,
        summary: options.summary,
        nextStep: null,
        historyProgress: null,
        selectedWindowDays: null,
        dataQuality: {
            observationDays: 0,
            completeDays: 0,
            confidentDays: 0,
            suspiciousDays: 0,
            incompleteDays: 0,
            missingDays: 0,
            weightPoints: 0,
            weightSpanDays: 0
        },
        missingCriteria: options.missingCriteria,
        assumptions: [],
        estimates: {
            averageIntakeKcal: null,
            observedWeeklyWeightChangeKg: null,
            targetAdjustmentKcal: null,
            configuredWeeklyWeightChangeKg: -((options.configuredDailyDeficitKcal ?? 0) * 7) / 7700
        },
        recommendation: null,
        activityContext: null,
        assessment: {
            version: CALIBRATION_ASSESSMENT_VERSION,
            state: 'waiting',
            paceStatus: null,
            window: null,
            recentWeightTrendKgPerWeek: null,
            goalRateKgPerWeek: -((options.configuredDailyDeficitKcal ?? 0) * 7) / 7700,
            blocker: options.blocker ?? 'plan_unavailable',
            targetDecision: 'waiting',
            targetDecisionBlocker: null,
            minimumDailyCalorieTargetKcal: CALIBRATION_MIN_TARGET_KCAL
        }
    };
}

/** Return a non-actionable compatibility response and any previously approved future revision, without evaluating tracking. */
export function buildCalibrationStatus(userId: number, now = new Date()): Promise<CalibrationStatus> {
    return prisma.$transaction(async tx => {
        const planning = await buildStoredCaloriePlanningSnapshot(tx, userId, now);
        if (!planning) throw new CalibrationConflictError('User not found.');
        const today = getSafeUtcTodayDateOnlyInTimeZone(planning.user.timezone, now);
        const revision = planning.nextRevision;
        const target = revision && planning.evaluation.tdee !== null && planning.goal
            ? Math.round(planning.evaluation.tdee - planning.goal.daily_deficit + revision.target_adjustment_kcal) : null;
        return {
            generatedAt: now.toISOString(), inputFingerprint: null,
            evaluation: buildUnavailableEvaluation({
                asOfDate: toDateKey(addUtcDays(today, -1)), weightUnit: planning.user.weight_unit,
                headline: 'Plan check has changed', summary: 'Update the app to view descriptive tracking summaries and weekly reports.',
                missingCriteria: [], configuredDailyDeficitKcal: planning.goal?.daily_deficit
            }),
            recommendation: null,
            scheduledChange: revision ? {
                recommendationId: revision.recommendation_id, targetAdjustmentKcal: revision.target_adjustment_kcal,
                dailyCalorieBudgetKcal: planning.evaluation.status === 'available' && revision.calorie_plan_review_status === 'CLEAR' && target !== null && target >= (planning.evaluation.minimumDailyCalorieTarget ?? Infinity) ? target : null,
                effectiveLocalDate: toDateKey(revision.effective_local_date)
            } : null,
            planStatus: planning.evaluation.status, planReasonCode: planning.evaluation.reasonCode
        };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** Reject all new calibration applications, including stale recommendations retained by older clients. */
export async function applyCalibrationRecommendation(_options: {
    userId: number; recommendationId: number; operationId?: string; now?: Date;
}): Promise<ScheduledCalibrationChange> {
    throw new CalibrationConflictError('Calorie-target recommendations have been retired. Update the app to view your progress summary.');
}

/** Undo a not-yet-effective calibration revision without reactivating retired recommendations. */
export async function cancelScheduledCalibrationChange(options: {
    userId: number;
    recommendationId: number;
    operationId?: string;
    now?: Date;
}): Promise<CalibrationStatus> {
    const user = await prisma.user.findUnique({
        where: { id: options.userId },
        select: { timezone: true }
    });
    if (!user) throw new CalibrationConflictError('User not found.');

    const today = getSafeUtcTodayDateOnlyInTimeZone(user.timezone, options.now ?? new Date());
    await executeIdempotentMutation<{ recommendationId: number; canceled: true }>({
        userId: options.userId,
        operationId: options.operationId,
        operationKind: 'calibration_recommendation.cancel',
        requestPayload: { recommendation_id: options.recommendationId },
        mutate: async (tx, claimedOperationId) => {
            await lockCaloriePlanningInputs(tx, options.userId);
            const recommendation = await tx.calibrationRecommendation.findFirst({
                where: {
                    id: options.recommendationId,
                    user_id: options.userId,
                    status: 'APPLIED'
                },
                include: { plan_revision: true }
            });
            const revision = recommendation?.plan_revision;
            if (!recommendation || !revision) {
                throw new CalibrationConflictError('This calorie budget update is no longer scheduled. Refresh calibration to see the latest plan.');
            }
            if (revision.effective_local_date <= today) {
                throw new CalibrationConflictError('This calorie budget update has already started and can no longer be undone as a scheduled change.');
            }

            await tx.caloriePlanRevision.delete({ where: { id: revision.id } });
            await tx.calibrationRecommendation.update({
                where: { id: recommendation.id },
                data: { status: 'STALE', applied_at: null }
            });
            await observeCurrentCaloriePlan(tx, options.userId, options.now);
            await recordSyncChange({
                tx,
                userId: options.userId,
                entityType: 'calorie_plan_revision',
                entityId: revision.id,
                action: 'delete',
                operationId: claimedOperationId,
                payload: {
                    recommendationId: recommendation.id,
                    effectiveLocalDate: toDateKey(revision.effective_local_date)
                }
            });
            return {
                status: 200,
                body: { recommendationId: recommendation.id, canceled: true }
            };
        }
    });

    return buildCalibrationStatus(options.userId, options.now);
}
